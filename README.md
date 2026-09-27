# Feed Log

A simple installable web app for logging newborn breastfeeding (start time, minutes per side, and the resulting end
time) and diapers (time, pee and/or poop).

Live: https://joho9119.github.io/feed-tracker/

## Sync

Entries sync between phones through an Airtable base with two tables:

- **Feeds**: **Start** (date/time), **Left** and **Right** (numbers, minutes)
- **Diapers**: **Time** (date/time), **Pee** and **Poop** (checkboxes)
 Tap the sync status in the top-right corner and enter the base ID (or paste any
Airtable link to the base) plus a personal access token with `data.records:read` and `data.records:write` scoped to
that base. Both are stored only on the device.

The app shows the last 30 days; full history lives in Airtable. Changes made offline are queued and pushed when the
phone is back online. The app checks for the other phone's changes every 30 seconds while open.
