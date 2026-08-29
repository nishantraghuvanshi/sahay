# Reconciling the two schedule schemas

Two independent data models for the same domain arrived on `main` from different
lanes. The founder's call, 30 Aug: **TRD §3 names win, and the scheduler's columns
are folded into them.**

`api/schema.sql` is now that reconciled schema. This document is what Lane A needs
in order to move onto it.

---

## Why there were two

Neither lane was wrong. They cut the same domain for different jobs:

* **`agent/src/adapters/persistence/sqlite.js`** was built for the dialler. It knows
  about retries, when a course starts, and who confirmed — the things you need to
  decide whether to place a call right now.
* **`api/schema.sql`** follows TRD §3, which both lanes were meant to build against.
  It carries the record and the consent chain — prescription provenance, the FR-4
  sign-off, PRN exclusion — and the five tables the caregiver app renders that the
  agent's model has no use for.

The overlap is `medications` and `dose_events`. Everything else is additive.

---

## What changed in `api/schema.sql`

Four columns adopted from the agent's model, unchanged in meaning:

| Column | Table | Why it is load-bearing |
|---|---|---|
| `start_date` | `medications` | Without it a taper — the same medicine at a different dose from a later date — cannot be expressed, and the dialler cannot tell a course has not begun |
| `attempt_count` | `dose_events` | The initial dial plus retries counts up from here |
| `next_attempt_at` | `dose_events` | When the row becomes eligible again, so a dose dialled once is not picked up before its retry is due |
| `actor` | `dose_events` | `'agent'` / `'caregiver'` / `'patient'`. A dose the caregiver ticked in the app and one the patient confirmed on a call are different facts |

And one status value: **`pending`**. It is the scheduler's own bookkeeping — the row
exists so the counters have somewhere to live and nothing has been established. It
is **not an outcome**. The app reads it exactly as it reads no row at all: excluded
from the dose history, excluded from every tally, rendered as "upcoming" (or
"trying · 2 attempts" where the count is non-zero).

---

## Column mapping for Lane A

| Concept | `agent/` today | `api/schema.sql` | Note |
|---|---|---|---|
| medication id | `INTEGER AUTOINCREMENT` | `TEXT` uuid4 | **The only hard change.** Ids are not interchangeable; rows need re-keying, not renaming |
| dose times | `times` | `slots` | Rename. Same JSON array of local `'HH:MM'` |
| food rule | `food_rule` | `with_food` | Rename. Values `before` / `after` / `any` |
| stopped | `active` (0/1) | `stopped_at` (timestamp) | `active = 0` becomes a timestamp. The app also needs *when* |
| course start | `start_date` | `start_date` | Unchanged |
| course end | `end_date` | `end_date` | Unchanged |
| priority | `is_priority` | `is_priority` | Unchanged |
| dose event id | `INTEGER` | `TEXT` uuid4 | Same re-keying as above |
| call link | `call_id` | `call_session_id` | Rename, and it references `call_sessions(id)` |
| confirmed at | `confirmed_at` | `created_at` + `actor` | The event's own timestamp is when it was written |
| retries | `attempt_count`, `next_attempt_at` | same | Unchanged |
| status | 6 values | same 6 values | **Already identical** — both lanes arrived at `pending`, `confirmed`, `deferred`, `missed`, `no_answer`, `unknown` independently |

Columns the agent's model does not have and will inherit: the prescription
provenance chain (`raw_line`, `confidence`, `extraction_flags`, `source`,
`source_doc_id`), the FR-4 gate (`confirmed_by` / `confirmed_at`, both `NOT NULL`),
PRN exclusion (`excluded`, `exclusion_reason`), and `rescheduled_to`.

---

## What has NOT been done

**`agent/` is untouched.** Lane A has 60 commits of live, working calling code, and
rewriting its persistence layer underneath it — while it is the only thing in the
build placing real phone calls — is not a change to make without them.

Two stores therefore still exist:

* `agent/data/voiceagent.db` — what the dialler reads
* `api/kinvox.db` — what the caregiver app reads and writes

They do not talk. **A dose moved on the calendar does not change which call is
placed, and the agent's confirmations never reach the calendar.** That is the whole
cost of the split and the reason to close it.

## Closing it

Two routes, in increasing order of work:

1. **Agent reads the Care API.** `GET /app/record` already returns the schedule and
   `POST /app/doses` already records an outcome with an `actor`. The agent's SQLite
   drops back to call state only — `sessions`, `messages`, `calls` — which is the
   part of its model nothing else wants. No schema migration, one adapter.
2. **One database, one schema.** The agent points at `api/schema.sql` directly.
   Cleanest end state, but it means re-keying every `INTEGER` id to a uuid and
   touching the repository layer, its 33 medication and scheduling tests, and the
   seed script.

Route 1 is the smaller change and keeps each lane's tests passing. It is the one
worth costing first.
