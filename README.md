# Feed Log

A simple installable web app for logging newborn breastfeeding (start time, minutes per side, and the resulting end
time) and diapers (time, pee and/or poop).

Each side has a live timer: tap to start, tap again to stop and add the elapsed minutes to that side. A feed in
progress is saved on the device, so the timer survives the phone locking or the app being closed.

Live: https://joho9119.github.io/feed-tracker/

## Sync

Entries sync between phones through an Airtable base with two tables:

- **Feeds**: **Start** (date/time), **Left duration** and **Right duration** (durations, exact seconds), plus
  **Left** and **Right** (numbers, the durations rounded to minutes for readability)
- **Diapers**: **Time** (date/time), **Pee** and **Poop** (checkboxes)
 Tap the sync status in the top-right corner and enter the base ID (or paste any
Airtable link to the base) plus a personal access token with `data.records:read` and `data.records:write` scoped to
that base. Both are stored only on the device.

The app shows the last 30 days; full history lives in Airtable. Changes made offline are queued and pushed when the
phone is back online. The app checks for the other phone's changes every 30 seconds while open.
