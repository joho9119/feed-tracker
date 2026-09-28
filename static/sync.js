// Airtable sync for Feed Log.
//
// Entries sync to Airtable, one table per entry type. localStorage is the
// offline cache: new entries get a "local-" id until Airtable assigns a "rec"
// id, edits to synced entries are flagged `pending`, and deletes wait in a
// queue until pushed.
//
// Each sync fetches recent records (which also proves the token and base
// work), pushes any queued local changes, re-fetches, then merges the remote
// records with whatever is still unsynced locally.
//
// Loaded before app.js. Used from app.js at runtime:
//   entries, deleted                 local entry list and delete queue (both
//                                    are reassigned here, not just read)
//   persist(), sortEntries(), render()
//   onEntryIdChanged(oldId, newId)   a new entry received its Airtable id
//   toMin(), fmtTime(), $()
// Provided to app.js:
//   TYPES, SYNC_DAYS, isLocal(), unsyncedCount(), sync(), renderStatus(),
//   startSync()

const TYPES = {
  feed: {
    table: 'Feeds',
    fields: ['Start', 'Left', 'Right', 'Left duration', 'Right duration', 'Note'],
    // Durations hold exact seconds; Left/Right keep the displayed minutes so
    // the spreadsheet stays readable.
    toFields: (e) => ({
      Start: e.start,
      Left: toMin(e.leftSec),
      Right: toMin(e.rightSec),
      'Left duration': e.leftSec,
      'Right duration': e.rightSec,
      Note: e.note || '',
    }),
    fromFields: (f) => {
      const hasDuration = f['Left duration'] != null || f['Right duration'] != null;
      return {
        start: f.Start,
        leftSec: hasDuration ? f['Left duration'] || 0 : (f.Left || 0) * 60,
        rightSec: hasDuration ? f['Right duration'] || 0 : (f.Right || 0) * 60,
        note: f.Note || '',
      };
    },
  },
  diaper: {
    table: 'Diapers',
    fields: ['Time', 'Pee', 'Poop', 'Note'],
    toFields: (e) => ({ Time: e.start, Pee: e.pee, Poop: e.poop, Note: e.note || '' }),
    fromFields: (f) => ({ start: f.Time, pee: !!f.Pee, poop: !!f.Poop, note: f.Note || '' }),
  },
};

const SYNC_DAYS = 30;
const POLL_MS = 30000;
const SYNC_KEYS = { token: 'airtable.token', base: 'airtable.base' };

let token = localStorage.getItem(SYNC_KEYS.token) || '';
let base = localStorage.getItem(SYNC_KEYS.base) || '';
let sync_ = { running: false, again: false, state: 'idle', at: null };

const isLocal = (e) => !e.id.startsWith('rec');
const unsyncedCount = () => entries.filter((e) => isLocal(e) || e.pending).length + deleted.length;

// ---------- Airtable ----------

async function api(type, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${base}/${TYPES[type].table}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Airtable ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchRecent(type) {
  const { fields, fromFields } = TYPES[type];
  const timeField = fields[0];
  const params = new URLSearchParams({
    filterByFormula: `IS_AFTER({${timeField}}, DATEADD(NOW(), -${SYNC_DAYS}, 'days'))`,
    'sort[0][field]': timeField,
    'sort[0][direction]': 'desc',
    pageSize: '100',
  });
  fields.forEach((f) => params.append('fields[]', f));
  const out = [];
  let offset;
  do {
    if (offset) params.set('offset', offset);
    const page = await api(type, `?${params}`);
    for (const r of page.records) {
      if (!r.fields[timeField]) continue;
      out.push({ id: r.id, type, ...fromFields(r.fields) });
    }
    offset = page.offset;
  } while (offset);
  return out;
}

async function fetchAll() {
  const lists = await Promise.all(Object.keys(TYPES).map(fetchRecent));
  return lists.flat();
}

// A record-level 403/404/422 after the token has just been proven valid means
// the other phone already deleted that record.
const isGone = (err) => [403, 404, 422].includes(err.status);

async function pushChanges() {
  for (const d of [...deleted]) {
    try { await api(d.type, `/${d.id}`, { method: 'DELETE' }); }
    catch (err) { if (!isGone(err)) throw err; }
    deleted = deleted.filter((x) => x.id !== d.id);
    persist();
  }

  for (const e of entries.filter((x) => !isLocal(x) && x.pending)) {
    try {
      await api(e.type, `/${e.id}`, { method: 'PATCH', body: { fields: TYPES[e.type].toFields(e) } });
      e.pending = false; // no-op if the user replaced this object mid-request
    } catch (err) {
      if (!isGone(err)) throw err;
      entries = entries.filter((x) => x !== e);
    }
    persist();
  }

  for (const type of Object.keys(TYPES)) {
    const creates = entries.filter((e) => e.type === type && isLocal(e));
    for (let i = 0; i < creates.length; i += 10) {
      const batch = creates.slice(i, i + 10);
      const res = await api(type, '', {
        method: 'POST',
        body: { records: batch.map((e) => ({ fields: TYPES[type].toFields(e) })) },
      });
      batch.forEach((sent, j) => {
        const recId = res.records[j].id;
        const localId = sent.id; // read first: `sent` is usually `current`
        const current = entries.find((x) => x.id === localId);
        if (!current) { deleted.push({ id: recId, type }); return; } // deleted while in flight
        current.pending = current !== sent; // edited while in flight: push again
        current.id = recId;
        onEntryIdChanged(localId, recId);
      });
      persist();
    }
  }
}

function mergeRemote(remote) {
  const gone = new Set(deleted.map((d) => d.id));
  const local = entries.filter((e) => isLocal(e) || e.pending);
  const localIds = new Set(local.map((e) => e.id));
  entries = [...remote.filter((r) => !gone.has(r.id) && !localIds.has(r.id)), ...local];
  sortEntries();
  persist();
}

async function sync() {
  if (!token || !base) return renderStatus();
  if (sync_.running) { sync_.again = true; return; }
  sync_.running = true;
  sync_.state = 'busy';
  renderStatus();
  try {
    let remote = await fetchAll(); // also proves the token and base work
    if (unsyncedCount() > 0) {
      await pushChanges();
      remote = await fetchAll();
    }
    mergeRemote(remote);
    sync_.state = 'ok';
    sync_.at = new Date();
  } catch (err) {
    sync_.state = [401, 403, 404].includes(err.status) ? 'auth' : 'offline';
  } finally {
    sync_.running = false;
    render();
    if (sync_.again) { sync_.again = false; sync(); }
  }
}

function renderStatus() {
  const el = $('syncStatus');
  const n = unsyncedCount();
  const unsynced = n ? ` · ${n} unsynced` : '';
  let text, state;
  if (!token || !base) { text = 'Set up sync'; state = 'error'; }
  else if (sync_.state === 'busy') { text = 'Syncing…'; state = 'busy'; }
  else if (sync_.state === 'auth') { text = 'Check sync settings'; state = 'error'; }
  else if (sync_.state === 'offline') { text = `Offline${unsynced}`; state = 'error'; }
  else if (sync_.state === 'ok') { text = `Synced ${fmtTime(sync_.at)}${unsynced}`; state = 'ok'; }
  else { text = `Not synced${unsynced}`; state = 'busy'; }
  el.textContent = text;
  el.dataset.state = state;
}

// ---------- Settings ----------

function openSettings() {
  $('baseInput').value = base;
  $('tokenInput').value = token;
  $('settingsError').hidden = sync_.state !== 'auth';
  $('settingsError').textContent = 'Airtable rejected these settings. Check the base ID and the token\'s scopes and base access.';
  $('removeTokenBtn').hidden = !token && !base;
  $('settings').showModal();
}

function saveSetting(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function setSyncSettings(baseValue, tokenValue) {
  base = baseValue.match(/app[A-Za-z0-9]{14}/)?.[0] || '';
  token = tokenValue.trim();
  saveSetting(SYNC_KEYS.base, base);
  saveSetting(SYNC_KEYS.token, token);
  sync_.state = 'idle';
  $('settings').close();
  render();
  sync();
}

// ---------- Startup ----------

// Called once by app.js after local state is loaded: wires the settings
// dialog, starts polling, and runs the first sync.
function startSync() {
  $('syncStatus').addEventListener('click', openSettings);
  $('saveTokenBtn').addEventListener('click', () => setSyncSettings($('baseInput').value, $('tokenInput').value));
  $('removeTokenBtn').addEventListener('click', () => setSyncSettings('', ''));
  $('closeSettingsBtn').addEventListener('click', () => $('settings').close());

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  window.addEventListener('online', sync);
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, POLL_MS);
  sync();
}
