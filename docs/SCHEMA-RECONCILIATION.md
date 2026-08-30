# One schedule schema

Two independent data models for the same domain arrived on `main` from different
lanes. The founder's call, 30 Aug: **TRD §3 names win, and the scheduler's columns
fold into them.** That is done.

`api/schema.sql` is now the only schema in the product. `agent/` reads it at boot
rather than declaring its own, and both processes use one database file.

---

## Why there were two

Neither lane was wrong. They cut the same domain for different jobs:

* **`agent/`** was built for the dialler — retries, when a course starts, who
  confirmed. What you need to decide whether to place a call right now.
* **`api/schema.sql`** follows TRD §3, which both lanes were meant to build
  against. It carries the record and the consent chain, plus the five tables the
  caregiver app renders that the dialler has no use for.

The overlap was `patients`, `medications` and `dose_events`.

---

## What the merge did

**Adopted from the dialler's model**, unchanged in meaning:

| Column | Table | Why it is load-bearing |
|---|---|---|
| `start_date` | `medications` | Half of the `(patient_id, name, start_date)` key that lets a taper exist as two rows. `NOT NULL`, because SQLite treats NULLs as distinct in a unique index and a nullable one would silently admit the duplicates the index exists to prevent |
| `attempt_count`, `next_attempt_at` | `dose_events` | The retry pacing. Without them the scheduler cannot avoid re-dialling a dose it has already tried |
| `actor` | `dose_events` | `agent` / `caregiver` / `patient` |
| `call_id` | `dose_events` | The provider's call id. Not a duplicate of `call_session_id`: that points at `call_sessions`, this at `calls` |
| `timezone`, `quiet_windows` | `patients` | A local `'HH:MM'` slot is not an instant without a timezone, and quiet windows are the do-not-call hours a priority medicine may override |
| `pending` | status | The scheduler's bookkeeping, so counters have a row to live on. **Not an outcome** — the app reads it exactly as it reads no row at all |

**Kept as the dialler's own:** `calls`, `sessions`, `messages`. That is how a call is
*conducted*; what a call *produces* lands in the shared tables. Merging them into
`call_sessions` would have been a third rewrite with no reader to benefit.

**Renamed in `agent/`:** `times` → `slots`, `food_rule` → `with_food`,
`active` → `stopped_at`. Nothing outside its repository layer read those, so the
change stopped at the SQL.

**Normalised:** `caregiver_name` / `caregiver_phone` were columns on `patients`, one
copy per patient. They are now a row in `caregivers`, joined and aliased back to the
same names, so `inbound-context.js` and the tests that assert on them did not change.
One caregiver record instead of a copy per patient.

---

## Two constraints were deliberately relaxed

Both were mine, and both were wrong once the models merged. Recorded because the
reasoning matters more than the change:

**`patients.caregiver_id`, `patients.name`** — were `NOT NULL`. That held while
onboarding was the only thing creating patients. The agent resolves inbound callers,
and a patient it has met by number but whose name or caregiver nobody has recorded is
a real state, not a broken row.

**`medications.confirmed_by` / `confirmed_at`** — were `NOT NULL`, and I argued for
that specifically: *"a nullable `confirmed_by` is a gate that defaults to open."* It
is not the gate. Two other things are, and both bite harder:

* `POST /app/onboarding` refuses a draft whose schedule was not signed off, and
* the dial policy's **first** check is
  `patient.schedule_signed_off_at == null → skip`, with the literal rule string.

The column being `NOT NULL` only blocked rows that legitimately exist before anyone
has confirmed them — a seeded regimen, a prescription read but not yet reviewed. The
guarantee is unchanged and is pinned by tests on both sides.

---

## What this bought

The thing the split cost, gone: a dose moved on the calendar now changes which call
is placed, and the agent's confirmations reach the calendar.

Verified end to end against one database:

1. `POST /app/onboarding` creates a patient and a signed-off schedule.
2. The agent's `findPatientByPhone` / `listMedications` read it — slots, food rule,
   timezone, sign-off, and the prescription's `raw_line` and confidence.
3. The agent's `upsertDoseEvent` records an outcome from a call.
4. `GET /app/doses` returns it, with `actor` and `call_id`.

**693 tests pass:** 588 in `agent/`, 78 in `api/`, 27 in `app/`.

---

## Notes for whoever runs this

* `VOXIKIN_DB` points both processes at one file. Unset, both default to
  `api/voxikin.db`. The agent still honours `DB_PATH` for its own scripts.
* `api/db.py` has a migration that ALTERs columns onto an existing database, because
  `CREATE TABLE IF NOT EXISTS` skips a table that already exists and a new column
  would otherwise never appear on an older file.
* Ids are TEXT uuids everywhere. The agent generates them in `newId()`; nothing in
  its code assumed numeric ids, but `ORDER BY created_at DESC, id DESC` did quietly
  depend on the old autoincrement to break ties within a second. Those are
  `rowid DESC` now.
