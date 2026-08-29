# Schema gaps found while building the caregiver app

Lane C, raised against `TRD §3`. Each item is something the **wireframes or the checklist ask
the app to show** that the data model currently cannot store. None of these block Lane C — the
app is built without them — but each is a field the record will silently drop.

Ordered by how much the demo cares.

> **Status, 30 Aug 03:5x — most of these are now built.** `api/schema.sql` implements the
> Care API against TRD §3 in SQLite, and the columns below are in it, marked `[GAP-n]`.
> Closed: **1** (verification timestamps), **2** (intro call + consents), **4** (`end_date`,
> `duration_days`), **5** (`escalation_contacts`), **7** (extraction provenance and the
> required `confirmed_by`/`confirmed_at`). Table created but nothing writes to it yet: **3**
> (`medication_changes`). Still genuinely open: **6** (`stock_count`) and the new **8** below.
>
> The gaps are described in their original wording rather than rewritten, because the
> reasoning for each is why the column exists.


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

## 7. A schedule read from a prescription loses its provenance at the database

Added when prescription extraction was wired up (`api/rx_extract`). This one is a **safety**
gap, not a convenience one.

The extractor returns, per medicine, the verbatim `raw_line` it claims it read off the paper,
a per-medicine `confidence`, and validation `flags`. Design doc §2 makes two of these
load-bearing:

> **S3** — every extracted medicine must carry a `raw_line` so a reviewer can compare against
> the photo. **S6** — the review UI shows a crop of the original image beside each parsed row.

`DraftMedicine` now carries these fields and the review screen displays `raw_line` beside every
row. But `medications` has nowhere to put them, so the moment a caregiver signs the schedule off
and it is posted, **the evidence for every row is discarded**. What survives is "Metformin 500mg
at 08:30" with no record of what the paper actually said, who confirmed it, or how sure the
model was. If a dose is later disputed, there is nothing to audit against.

```sql
ALTER TABLE medications ADD COLUMN source          TEXT;    -- 'prescription' | 'manual'
ALTER TABLE medications ADD COLUMN source_doc_id   TEXT;    -- the extraction doc_id
ALTER TABLE medications ADD COLUMN raw_line        TEXT;    -- verbatim reading (S3)
ALTER TABLE medications ADD COLUMN confidence      REAL;
ALTER TABLE medications ADD COLUMN extraction_flags JSONB;
```

Related and **required rather than optional** — the design doc §10 is explicit that the
scheduler must accept only confirmed schedules, and that the confirmation fields are `NOT NULL`,
not nullable-with-a-default. A nullable `confirmed_by` is a gate that defaults to open:

```sql
ALTER TABLE medications ADD COLUMN confirmed_by UUID NOT NULL REFERENCES caregivers(id);
ALTER TABLE medications ADD COLUMN confirmed_at TIMESTAMPTZ NOT NULL;
```

Two more fields the extractor produces that the schema cannot hold:

- **`excluded` / `exclusion_reason`.** PRN (`SOS`) medicines and non-oral forms — injections,
  ointments, drops — are read from the page and deliberately given no reminder (§3.3, safety
  rule 4). Today the app represents this in the draft only. Posted to a schema without the
  field, an SOS medicine becomes an ordinary row with no slots, and any future scheduler that
  fills in a default time would start calling a patient about a medicine they take as needed.
- **`duration_days`**, which is gap 4 above (`end_date`) seen from the other side: the
  extractor reads "x 5 days" off the page and there is no column for it, so reminders cannot
  auto-expire.

Also unstored: `unparsed_lines` — lines the model returned that failed validation. The app shows
them so a caregiver can add them by hand, but nothing records that a page had unreadable lines
at all.

## 8. Onboarding never asks the caregiver their own name

Found while writing `POST /app/onboarding`. The signup screen (`1a`) collects a phone and an
email; the parent screen (`1b`) collects the *parent's* name. Nobody ever asks the caregiver
what they are called.

`caregivers.name` is `NOT NULL`, so the endpoint has to put something there. It currently
stores the relationship, title-cased — a caregiver who said they are the son is recorded as
`"Son"`. That is not a name, and the care record screen displays it as one.

Two ways out, and this is a product call rather than a schema one:

- Ask for it on `1a`, next to the phone. One field, and it is the honest fix.
- Or drop `name` to nullable and have the UI fall back to the relationship explicitly
  ("Your son"), so the record never claims to know a name it was never told.

Until then the field holds a label, not a name, and anything that greets the caregiver by it
will read strangely.

---

**What Lane C needs back, whenever you get to it** (see `docs/checklists/LANE-C-APP.md`): the app
cannot hold `CARE_API_TOKEN` in the browser (`NFR-7`). Caregiver-scoped read endpoints —
`GET /app/record`, `/app/doses`, `/app/observations`, `/app/escalations`, `/app/summary`, and
`GET /h/{token}` — let the app drop its mock with a one-line base-URL change. The response shapes
Lane C is already built against are in `scripts/mock-api.json`.
