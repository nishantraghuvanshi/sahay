# Schema gaps found while building the caregiver app

Lane C, raised against `TRD §3`. Each item is something the **wireframes or the checklist ask
the app to show** that the data model currently cannot store. None of these block Lane C — the
app is built without them — but each is a field the record will silently drop.

Ordered by how much the demo cares.

## 1. The four-step signup has nowhere to record verification

`caregivers` holds `phone_e164` and `email`, but nothing says either was verified. Screen `1a`
verifies both by OTP.

```sql
ALTER TABLE caregivers ADD COLUMN phone_verified_at TIMESTAMPTZ;
ALTER TABLE caregivers ADD COLUMN email_verified_at TIMESTAMPTZ;
```

## 2. The consent gate (`1E.2`) has nowhere to land

`patients.schedule_signed_off_at` covers FR-4. It does not cover the intro call (FR-5) or the
three consents (SR-5). Right now the app collects all of it and can post none of it.

```sql
ALTER TABLE patients ADD COLUMN intro_call_at     TIMESTAMPTZ;
ALTER TABLE patients ADD COLUMN intro_call_status TEXT;   -- 'pending'|'done'|'declined'
ALTER TABLE patients ADD COLUMN consents          JSONB;  -- [{id, text, agreed_at}]
```

`intro_call_status` is load-bearing: **the scheduler must not dial a dose slot until it is
`done`**, otherwise the product calls a parent who never agreed to be called.

Consents are stored with their *text*, not just a boolean — a consent you cannot reproduce is
not evidence.

## 3. Medicine edits (`1G.2`) need an audit row

The edit screen requires an explicit tick: *"these changes have been explicitly advised by our
doctor."* Storing the tick as a boolean on nothing loses who changed what, and when.

```sql
CREATE TABLE medication_changes (
  id           UUID PRIMARY KEY,
  patient_id   UUID NOT NULL REFERENCES patients(id),
  changed_at   TIMESTAMPTZ DEFAULT now(),
  changed_by   UUID REFERENCES caregivers(id),
  diff         JSONB NOT NULL,
  consent_text TEXT NOT NULL,
  consent_ack  BOOLEAN NOT NULL
);
```

## 4. `medications` has no end date

Both wireframes (`1e`, `2d`) and `LANE-C-APP.md` show an **End date** column; `medications` has
no such field. Lane C has deliberately **not** built the column rather than render a value the
database cannot hold — the record must match the DB, since a judge may cross-check.

Either add it, or drop it from the checklist so the two stop disagreeing:

```sql
ALTER TABLE medications ADD COLUMN end_date DATE;
```

## 5. The escalation ladder has no contacts table

`escalations.sent_to` is free text — a name, no number. So when the caregiver does not respond
and the app offers "Escalate to Priya", **there is no phone number to dial**. Lane C refuses to
invent one: the button renders disabled rather than guessing, which is why the demo currently
reads "Escalate to Shubh" (the caregiver themself, the one contact with a stored number) instead
of a second contact.

Onboarding already collects these people — name, relationship, and after-how-long — and drops
them on the floor for the same reason.

```sql
CREATE TABLE escalation_contacts (
  id            UUID PRIMARY KEY,
  patient_id    UUID NOT NULL REFERENCES patients(id),
  name          TEXT NOT NULL,
  relationship  TEXT,
  phone_e164    TEXT NOT NULL,
  after_minutes INT,          -- NULL = critical only
  rank          INT NOT NULL
);
```

Cheap to add, and it is the difference between the escalation ladder being real and being a
label. `PRD §12.1` describes the ladder as product behaviour, so today the docs promise something
the schema cannot do.

## 6. `stock_count` cannot round-trip through onboarding

`medications.stock_count` exists in the schema and in the seed, but nothing in the onboarding
flow collects it and the draft has no field for it, so a schedule created in the app posts
`NULL`. Fine if nothing consumes it — worth deleting from the seed if so, since a column that is
always null reads as a bug during a database spot check.

---

**What Lane C needs back, whenever you get to it** (see `docs/checklists/LANE-C-APP.md`): the app
cannot hold `CARE_API_TOKEN` in the browser (`NFR-7`). Caregiver-scoped read endpoints —
`GET /app/record`, `/app/doses`, `/app/observations`, `/app/escalations`, `/app/summary`, and
`GET /h/{token}` — let the app drop its mock with a one-line base-URL change. The response shapes
Lane C is already built against are in `scripts/mock-api.json`.
