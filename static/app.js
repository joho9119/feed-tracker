// Feed Log UI: entry forms, side timers, history and filters. Airtable sync
// lives in sync.js, which is loaded first; startSync() at the bottom hands
// over to it once local state is ready.

const TIMER_MAX_MIN = 120;
const K = { entries: 'feeds.v1', deleted: 'feeds.deleted', draft: 'feeds.draft' };
const $ = (id) => document.getElementById(id);

let entries = loadJson(K.entries, []).map(migrateEntry);
let deleted = loadJson(K.deleted, []).map((d) => (typeof d === 'string' ? { id: d, type: 'feed' } : d));
let mode = 'feed';
let editingId = null;
let editingType = null;
let expandedId = null;
let view = 'feed'; // 'feed' | 'diaper' | 'history'
const filters = { text: '', type: 'all', day: '' };

// Called by sync.js when Airtable assigns a record id to a new entry.
function onEntryIdChanged(oldId, newId) {
  if (editingId === oldId) editingId = newId;
  if (expandedId === oldId) expandedId = newId;
}

// Older saved entries have no type (pre-diapers) or whole minutes instead of
// seconds; deletes used to be bare ids.
function migrateEntry(e) {
  const entry = { type: 'feed', ...e };
  if (entry.type !== 'feed' || entry.leftSec !== undefined) return entry;
  const { left = 0, right = 0, ...rest } = entry;
  return { ...rest, leftSec: left * 60, rightSec: right * 60 };
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch { return fallback; }
}

function persist() {
  localStorage.setItem(K.entries, JSON.stringify(entries));
  localStorage.setItem(K.deleted, JSON.stringify(deleted));
}

const sortEntries = () => entries.sort((a, b) => new Date(b.start) - new Date(a.start));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// datetime-local needs "YYYY-MM-DDTHH:MM" in local time
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MAX_SIDE_SEC = 180 * 60;

// Seconds shown as whole minutes: nearest minute, but anything under a
// minute shows as 1.
const toMin = (sec) => (sec <= 0 ? 0 : sec < 60 ? 1 : Math.round(sec / 60));

// Exact seconds per side for the feed form; the inputs show toMin() of these.
const sideSec = { left: 0, right: 0 };

function setSide(side, sec) {
  sideSec[side] = Math.max(0, Math.min(MAX_SIDE_SEC, Math.round(sec)));
  $(side).value = toMin(sideSec[side]);
}

function minutes(id) {
  const n = Math.round(Number($(id).value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 180) : 0;
}

const pressed = (id) => $(id).getAttribute('aria-pressed') === 'true';
const setPressed = (id, on) => $(id).setAttribute('aria-pressed', String(on));

function endOf(feed) {
  return new Date(new Date(feed.start).getTime() + (feed.leftSec + feed.rightSec) * 1000);
}

function diaperLabel(e) {
  if (e.pee && e.poop) return 'Pee & poop';
  return e.pee ? 'Pee' : 'Poop';
}

const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

// ---------- Form ----------
// While a side timer is in use the feed form is a draft that is persisted,
// so it survives the phone locking or the app being closed mid-feed.

let timer = null; // { side: 'left' | 'right', since: epoch ms }
let draftActive = false;
let startTouched = false;

let timerNote = '';

// Elapsed time on the running timer, capped at TIMER_MAX_MIN.
const runningMs = () => (timer ? Math.min(Date.now() - timer.since, TIMER_MAX_MIN * 60000) : 0);
const runningSec = () => Math.round(runningMs() / 1000);
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const editingCurrent = () => !!editingId && editingType === mode;

function saveDraft() {
  if (!draftActive) return localStorage.removeItem(K.draft);
  localStorage.setItem(K.draft, JSON.stringify({
    start: $('feedStart').value, leftSec: sideSec.left, rightSec: sideSec.right, note: $('feedNote').value, timer,
  }));
}

function restoreDraft() {
  const d = loadJson(K.draft, null);
  if (!d) return false;
  $('feedStart').value = d.start;
  setSide('left', d.leftSec ?? (d.left || 0) * 60);
  setSide('right', d.rightSec ?? (d.right || 0) * 60);
  $('feedNote').value = d.note || '';
  timer = d.timer;
  draftActive = true;
  startTouched = true;
  return true;
}

// Stops a timer that has hit the cap, including one left running while the
// app was closed.
function enforceTimerLimit() {
  if (!timer || Date.now() - timer.since < TIMER_MAX_MIN * 60000) return;
  const side = timer.side;
  stopTimer();
  timerNote = `${side === 'left' ? 'Left' : 'Right'} timer stopped automatically at ${TIMER_MAX_MIN} min`;
  updateForm();
}

function stopTimer() {
  if (!timer) return;
  const side = timer.side;
  setSide(side, sideSec[side] + runningSec());
  timer = null;
  saveDraft();
  updateForm();
}

function toggleTimer(side) {
  const wasRunning = timer?.side;
  stopTimer();
  if (wasRunning === side) return;
  if (!draftActive && !startTouched && sideSec.left + sideSec.right === 0) {
    $('feedStart').value = toLocalInput(new Date());
  }
  timer = { side, since: Date.now() };
  timerNote = '';
  draftActive = true;
  saveDraft();
  updateForm();
}

function renderTimers() {
  document.querySelectorAll('.timer').forEach((btn) => {
    const running = timer?.side === btn.dataset.side;
    btn.classList.toggle('running', running);
    btn.textContent = running ? `■ ${fmtElapsed(runningMs())}` : '▶ Start timer';
    btn.disabled = editingType === 'feed';
  });
  $('feedTab').classList.toggle('running', !!timer);
}

function showView(v) {
  view = v;
  document.querySelectorAll('#viewTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('entryView').hidden = v === 'history';
  $('historyView').hidden = v !== 'history';
  if (v === 'history') render();
}

function setMode(m) {
  mode = m;
  showView(m);
  $('feedFields').hidden = m !== 'feed';
  $('diaperFields').hidden = m !== 'diaper';
  updateForm();
}

function updateForm() {
  $('saveBtn').textContent = `${editingCurrent() ? 'Update' : 'Save'} ${mode}`;
  $('cancelBtn').textContent = editingCurrent() ? 'Cancel edit' : 'Discard';
  $('cancelBtn').hidden = !(editingCurrent() || (mode === 'feed' && draftActive));
  renderTimers();
  if (mode === 'diaper') {
    $('saveBtn').disabled = !$('diaperTime').value || !(pressed('peeBtn') || pressed('poopBtn'));
    return;
  }
  const startVal = $('feedStart').value;
  const totalSec = sideSec.left + sideSec.right + runningSec();
  if (!startVal) {
    $('summary').innerHTML = 'Pick a start time';
    $('saveBtn').disabled = true;
    return;
  }
  const end = new Date(new Date(startVal).getTime() + totalSec * 1000);
  $('summary').innerHTML = `Total <strong>${toMin(totalSec)} min</strong> &middot; Ends <strong>${fmtTime(end)}</strong>`
    + (timerNote ? `<div class="note">${timerNote}</div>` : '');
  $('saveBtn').disabled = totalSec === 0;
}

function resetFeed() {
  if (editingType === 'feed') { editingId = null; editingType = null; }
  timer = null;
  timerNote = '';
  draftActive = false;
  startTouched = false;
  $('feedStart').value = toLocalInput(new Date());
  setSide('left', 0);
  setSide('right', 0);
  $('feedNote').value = '';
  saveDraft();
}

function resetDiaper() {
  if (editingType === 'diaper') { editingId = null; editingType = null; }
  $('diaperTime').value = toLocalInput(new Date());
  setPressed('peeBtn', false);
  setPressed('poopBtn', false);
  $('diaperNote').value = '';
}

function resetForm(type) {
  if (type === 'feed') resetFeed(); else resetDiaper();
  updateForm();
  render();
}

function save() {
  if (mode === 'feed') stopTimer();
  const startVal = $(mode === 'feed' ? 'feedStart' : 'diaperTime').value;
  if (!startVal) return;
  const editing = editingCurrent();
  const common = {
    id: editing ? editingId : `local-${crypto.randomUUID?.() || Date.now()}`,
    type: mode,
    start: new Date(startVal).toISOString(),
    note: $(mode === 'feed' ? 'feedNote' : 'diaperNote').value.trim(),
  };
  const entry = mode === 'feed'
    ? { ...common, leftSec: sideSec.left, rightSec: sideSec.right }
    : { ...common, pee: pressed('peeBtn'), poop: pressed('poopBtn') };
  if (mode === 'feed' ? entry.leftSec + entry.rightSec === 0 : !(entry.pee || entry.poop)) return;
  if (editing) {
    entry.pending = !isLocal(entry);
    entries = entries.map((e) => (e.id === editingId ? entry : e));
  } else {
    entries.push(entry);
  }
  sortEntries();
  persist();
  resetForm(mode);
  sync();
}

function edit(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (e.type === 'feed' && draftActive && !confirm('Discard the feed in progress?')) return;
  if (editingType) resetForm(editingType);
  if (e.type === 'feed') {
    resetFeed();
    $('feedStart').value = toLocalInput(new Date(e.start));
    setSide('left', e.leftSec);
    setSide('right', e.rightSec);
  } else {
    resetDiaper();
    $('diaperTime').value = toLocalInput(new Date(e.start));
    setPressed('peeBtn', e.pee);
    setPressed('poopBtn', e.poop);
  }
  $(e.type === 'feed' ? 'feedNote' : 'diaperNote').value = e.note || '';
  editingId = id;
  editingType = e.type;
  setMode(e.type);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function remove(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(`Delete ${e.type} at ${fmtTime(new Date(e.start))}?`)) return;
  entries = entries.filter((x) => x.id !== id);
  if (!isLocal(e)) deleted.push({ id, type: e.type });
  persist();
  if (editingId === id) resetForm(e.type); else render();
  sync();
}

function daySummary(list) {
  const feeds = list.filter((e) => e.type === 'feed');
  const diapers = list.filter((e) => e.type === 'diaper');
  const parts = [];
  if (feeds.length) {
    const totalMin = toMin(feeds.reduce((s, f) => s + f.leftSec + f.rightSec, 0));
    parts.push(`${plural(feeds.length, 'feed')} &middot; ${totalMin} min`);
  }
  if (diapers.length) {
    const pee = diapers.filter((d) => d.pee).length;
    const poop = diapers.filter((d) => d.poop).length;
    parts.push(`${plural(diapers.length, 'diaper')} &middot; ${pee} pee &middot; ${poop} poop`);
  }
  return parts.join('<br>');
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const NOTE_ICON = `<svg class="note-icon" viewBox="0 0 16 16" role="img" aria-label="Has note">
  <path d="M3 1.5h10A1.5 1.5 0 0 1 14.5 3v7L10 14.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5z" fill="#f7d154" stroke="#c9a227"/>
  <path d="M10 14.5V11a1 1 0 0 1 1-1h3.5" fill="#e5bb3a" stroke="#c9a227" stroke-linejoin="round"/>
  <path d="M4.5 5.5h7M4.5 8h4" stroke="#a5831b" stroke-linecap="round"/>
</svg>`;

function entryHtml(e) {
  const pending = isLocal(e) || e.pending ? ' <span class="pending" title="Not synced yet">•</span>' : '';
  const expanded = e.id === expandedId;
  const [time, detail] = e.type === 'feed'
    ? [`${fmtTime(new Date(e.start))} – ${fmtTime(endOf(e))}`,
       `L ${toMin(e.leftSec)} min &middot; R ${toMin(e.rightSec)} min &middot; ${toMin(e.leftSec + e.rightSec)} min total`]
    : [`${fmtTime(new Date(e.start))} <span class="tag">Diaper</span>`, diaperLabel(e)];
  return `
    <li data-id="${e.id}" class="${e.id === editingId ? 'editing' : ''} ${expanded ? 'expanded' : ''}">
      <div class="info">
        <div class="time">${time}${e.note ? NOTE_ICON : ''}${pending}</div>
        <div class="detail">${detail}</div>
        ${(expanded || searchText()) && e.note ? `<div class="note-text">${escapeHtml(e.note)}</div>` : ''}
        ${expanded ? '<button class="edit-btn" type="button">Edit</button>' : ''}
      </div>
      <button class="del" aria-label="Delete">&times;</button>
    </li>`;
}

const localDay = (iso) => toLocalInput(new Date(iso)).slice(0, 10);
const searchText = () => filters.text.trim().toLowerCase();

function matchesFilters(e) {
  const q = searchText();
  return (filters.type === 'all' || e.type === filters.type)
    && (!filters.day || localDay(e.start) === filters.day)
    && (!q || (e.note || '').toLowerCase().includes(q));
}

function renderFilters() {
  document.querySelectorAll('#typeFilter button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === filters.type)));
  const today = new Date();
  $('dayFilter').max = localDay(today.toISOString());
  $('dayFilter').min = localDay(new Date(today - SYNC_DAYS * 86400000).toISOString());
}

function render() {
  renderStatus();
  renderFilters();
  const container = $('history');
  const shown = entries.filter(matchesFilters);
  $('filterStatus').hidden = !(searchText() || filters.day || filters.type !== 'all');
  $('filterCount').textContent = `Showing ${shown.length} of ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  if (entries.length === 0) {
    container.innerHTML = '<div class="card empty">Nothing logged yet</div>';
    return;
  }
  if (shown.length === 0) {
    container.innerHTML = '<div class="card empty">Nothing matches these filters</div>';
    return;
  }
  const groups = new Map();
  for (const e of shown) {
    const key = new Date(e.start).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  container.innerHTML = '';
  for (const [key, list] of groups) {
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `
      <div class="day-head">
        <h2>${fmtDay(new Date(key))}</h2>
        <span>${daySummary(list)}</span>
      </div>
      <ul>${list.map(entryHtml).join('')}</ul>`;
    container.appendChild(card);
  }
}

function exportCsv() {
  const fmt = (d) => toLocalInput(d).replace('T', ' ');
  const rows = [['type', 'start', 'end', 'left_min', 'right_min', 'total_min', 'left_sec', 'right_sec', 'pee', 'poop', 'note']];
  for (const e of [...entries].reverse()) {
    rows.push(e.type === 'feed'
      ? ['feed', fmt(new Date(e.start)), fmt(endOf(e)), toMin(e.leftSec), toMin(e.rightSec),
         toMin(e.leftSec + e.rightSec), e.leftSec, e.rightSec, '', '', e.note || '']
      : ['diaper', fmt(new Date(e.start)), '', '', '', '', '', '', e.pee ? 1 : 0, e.poop ? 1 : 0, e.note || '']);
  }
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const blob = new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `feed-log-${toLocalInput(new Date()).slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- Wiring ----------

document.querySelectorAll('button[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.target;
    setSide(id, sideSec[id] + Number(btn.dataset.step) * 60);
    saveDraft();
    updateForm();
  });
});
document.querySelectorAll('button[data-now]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $(btn.dataset.now).value = toLocalInput(new Date());
    if (btn.dataset.now === 'feedStart') startTouched = true;
    saveDraft();
    updateForm();
  });
});
document.querySelectorAll('.timer').forEach((btn) => btn.addEventListener('click', () => toggleTimer(btn.dataset.side)));
document.querySelectorAll('#viewTabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (v === 'history') return showView('history');
    // Switching to the other entry type abandons an edit; visiting History doesn't.
    if (v !== mode && editingType) resetForm(editingType);
    setMode(v);
  });
});
$('searchFilter').addEventListener('input', (e) => { filters.text = e.target.value; render(); });
$('dayFilter').addEventListener('change', (e) => { filters.day = e.target.value; render(); });
document.querySelectorAll('#typeFilter button').forEach((btn) => {
  btn.addEventListener('click', () => { filters.type = btn.dataset.type; render(); });
});
$('clearFilters').addEventListener('click', () => {
  Object.assign(filters, { text: '', type: 'all', day: '' });
  $('searchFilter').value = '';
  $('dayFilter').value = '';
  render();
});
['peeBtn', 'poopBtn'].forEach((id) => $(id).addEventListener('click', () => { setPressed(id, !pressed(id)); updateForm(); }));
$('feedStart').addEventListener('input', () => { startTouched = true; saveDraft(); updateForm(); });
$('diaperTime').addEventListener('input', updateForm);
$('feedNote').addEventListener('input', saveDraft);
// Typing a number replaces that side's exact seconds with whole minutes.
['left', 'right'].forEach((id) => $(id).addEventListener('input', () => {
  sideSec[id] = minutes(id) * 60;
  saveDraft();
  updateForm();
}));
['left', 'right'].forEach((id) => $(id).addEventListener('focus', (e) => e.target.select()));
$('saveBtn').addEventListener('click', save);
$('cancelBtn').addEventListener('click', () => {
  if (!editingCurrent() && !confirm('Discard this feed?')) return;
  resetForm(mode);
});
$('exportBtn').addEventListener('click', exportCsv);
$('history').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.target.closest('.del')) remove(li.dataset.id);
  else if (e.target.closest('.edit-btn')) edit(li.dataset.id);
  else if (e.target.closest('.info')) {
    expandedId = expandedId === li.dataset.id ? null : li.dataset.id;
    render();
  }
});
setInterval(() => { if (timer) { enforceTimerLimit(); updateForm(); } }, 1000);

if (!restoreDraft()) resetFeed();
resetDiaper();
enforceTimerLimit();
setMode('feed');
render();
startSync();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
