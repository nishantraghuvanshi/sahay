# The whole project, end to end
### Read this once before you build anything

---

## 1. In one sentence

> One phone line that **calls an ageing parent on schedule to manage medicines**, and
> **picks up when they call in** — where the inbound call already knows everything the
> outbound calls learned.

Every product in this category is one-directional. Reminder bots only call out, and
know just the schedule. Triage agents only pick up, and start from zero.
**The value is the loop between the two directions.**

---

## 2. Who is involved

| | | |
|---|---|---|
| **Sharma-ji, 68** | the parent | **Uses** the product. Interface is a phone call. Nothing else. Ever. Pays nothing |
| **Shubh, 34** | the adult child | **Pays** ₹499/mo. Lives in another city. Opens an app maybe twice a week |
| **A neighbour** | the third party | Never logs in. Arrives when something happens. Needs one readable screen, immediately |

The whole product design flows from that split. The person who needs help can't use an
app — 9.7% of these parents are smartphone-confident and a fifth are on feature phones.
But nearly all of them can answer a call. **The wedge is the call, not the app.**

---

## 3. What exists before any call happens

Shubh spends three minutes once:

```
caregivers   → Shubh, +91…, son
patients     → Sharma, honorific "ji", +91…, hi-IN, age 68
                conditions {hypertension, type-2 diabetes}
                allergies  {sulfa}
                doctor     Dr Rao, +91…
                address    …
                meal_times {breakfast 08:00, lunch 13:30, dinner 20:30}
                schedule_signed_off_at ← NULL until he explicitly signs off
medications  → Metformin 500mg  [08:30, 21:00]  after food  is_priority=true
                Amlodipine 5mg   [08:30]         any
                Vitamin D        [21:00]         any
```

Two gates sit on this record before the system is allowed to dial anyone:

- `schedule_signed_off_at IS NULL` → **no call is ever placed.** Not a warning, a refusal
- Shubh is told to inform his father that these calls are coming

The very first call to a new parent is a **warm introduction** — the agent says who it
is, who set it up, and why. It reminds nothing. That call exists so the second call
isn't a stranger.

---

## 4. Act I — Outbound. The part that looks boring and isn't.

Every day at 08:30 and 21:00 the scheduler fires.

```
scheduler (every 60s)
  ├── slot due?                              yes → continue
  ├── schedule signed off?                   no  → skip
  ├── calls_paused?                          yes → skip
  ├── active session for this patient?       yes → QUEUE, never dial over a live call
  ├── dose_event already exists for slot?    yes → skip (idempotent, no double-dial)
  └── create session (direction=out) → dial
```

The call itself is deliberately thin — four turns, under ninety seconds:

> **Agent:** Good morning Sharma-ji. It's time for your Metformin, the 500 milligram
> one, after breakfast. Have you taken it?
> **Sharma-ji:** Haan, le liya.
> → `log_dose(status="confirmed")`
>
> **Agent:** Good. How are you feeling this morning?
> **Sharma-ji:** Theek hoon, bas seene mein thoda tight lag raha hai.
> → `log_observation(text="seene mein thoda tight lag raha hai", severity="watch")`
> — **verbatim. never paraphrased.**

**This is the whole point of outbound.** It is not the product. It is the thing that
fills the record so that the inbound call has something to inherit. Four turns a day,
twice a day, and after a week the system knows this person.

If the observation had come back `red`, the agent does exactly three things, in this
order, and nothing else:

1. Acknowledge briefly
2. *"Please contact your doctor now"*
3. *"I am informing Shubh right now"* → then call `escalate`

It never says what the symptom means. It never says an ambulance is coming. It cannot
send one, and saying so would be a lie on camera.

---

## 5. Act II — The 2 AM call. This is the demo.

Sharma-ji dials the number himself.

### Before the agent says a single word

```
Twilio receives inbound
  → identify_caller(+91…)        →  patient_id, "Sharma", "ji", caregiver "Shubh"
  → resume_session(+91…)         →  no open session → create new (direction=in)
  → get_care_context(patient_id) →  meds, conditions, allergies, doctor,
                                    last 3 observations, missed_priority_dose_today
```

Three round trips, budget 500ms total, all finished **before the first agent turn**.

### Turn one

> **Agent:** Hello Sharma-ji — is this about the chest discomfort you mentioned this morning?

Nobody told the agent any of that on this call. It named the parent, referenced a
symptom from twelve hours earlier, and framed the question — three record facts,
unprompted, in one sentence. **That is the hero moment, and it happens in the first
four seconds.**

### The intake — six questions, not twelve

An emergency intake record has twelve fields. Here is what the system already holds:

| # | Field | Where it comes from |
|---|---|---|
| 1 | Caller identity + relationship | **asked** |
| 2 | Patient identity | inherited |
| 3 | Chief complaint, verbatim | **asked** |
| 4 | Onset time | **asked** |
| 5 | Responsive | **asked** |
| 6 | Breathing | **asked** |
| 7 | Location | prefilled — **confirm only** |
| 8 | Current medicines | inherited |
| 9 | Known allergies | inherited |
| 10 | Known conditions | inherited |
| 11 | Callback number | inherited from caller ID |
| 12 | Priority + cited rule | **computed** |

**Six of twelve arrive free.** That is the product, expressed as a number. A cold-start
competitor asks all twelve, to a frightened man, at two in the morning. We ask six, in
seven turns or fewer.

And critically — **`upsert_intake` fires after every single turn that yields a field.**
Not at the end of the call. Every turn. This one decision is what the next act depends on.

### Priority is computed, never guessed

When `responsive` and `breathing` are both known, the server runs a **pure function** —
no model call, ever:

```python
if responsive == "no":        return "P1", "rule: patient reported unresponsive"
if breathing  == "difficult": return "P1", "rule: reported breathing difficulty"
if "chest" in complaint and age > 40:
                              return "P1", "rule: chest complaint with age over 40"
...
return "P3", "rule: no P1 or P2 criteria met"
```

Rules are ordered, the first match wins, and **the literal rule text is stored on the
record and rendered in the UI.** Never `P1 — cardiac`. Always
`P1 — rule: chest complaint with age over 40`.

That distinction is not pedantry. It is the answer when a judge asks *"how do you know
it's a P1?"*, and it is the concrete evidence for the rubric's "governing business
rules" clause. It also keeps the system on the right side of the line: the rule
describes **what was reported**, never **what it means**.

### Then the escalation

```
escalate(P1, "rule: chest complaint with age over 40")
  ├── mint handoff token (32+ random bytes, 24h expiry)
  ├── WhatsApp to Shubh  → SMS if that fails  → and on P1, also ring him
  ├── write escalations row with delivery_status — a failed send is never silent
  └── return handoff_url
```

The message names **both** people and carries the rule text:

```
Voxikin alert — Sharma-ji
Reported chest tightness, onset 20 minutes ago. Responsive, breathing normal.
Priority P1 — rule: chest complaint with age over 40
Reported at 02:14
Full details: https://…/h/9f2c…
```

And the agent closes honestly:

> **Agent:** Please contact your doctor now, Sharma-ji. I have informed Shubh.

Not *"help is on the way."* We didn't send any.

---

## 6. Act III — The call drops. This is the part that wins Memory.

Sharma-ji's phone dies at field four.

```
session status → 'dropped'
resumable_until = started_at + 15 minutes
```

Sixty seconds later he redials from the same number.

```
identify_caller  → same patient
resume_session   → session_id, fields_so_far {complaint, onset, caller_identity, location},
                   missing ["responsive", "breathing"], elapsed_minutes 4
```

> **Agent:** I have you, Sharma-ji — chest tightness, about four minutes ago.
> I still need to know whether your breathing feels normal.

**Nothing is re-asked.** Not one question.

This works for exactly one reason: `upsert_intake` wrote every turn instead of batching
to call end. If it had batched, the drop would have lost everything, and this scene —
the single best forty seconds in the demo — would not exist. That's why the technical
doc explicitly forbids trading it away to save 200ms of latency.

---

## 7. Act IV — The handoff. Five seconds, one link, no login.

A neighbour arrives. Shubh forwards the link.

`/h/9f2c…` opens on the neighbour's phone. No app, no login, no account. The token
**is** the auth. One screen, no scrolling for the fields that matter:

> **Sharma, 68** · callback +91…
> **"seene mein tight lag raha hai"** — onset ~20 min
> Responsive: yes · Breathing: normal · At home
> Metformin 500mg, Amlodipine 5mg, Vitamin D
> Allergies: **sulfa** · Conditions: hypertension, type-2 diabetes
> Dr Rao +91…
> **P1 — rule: chest complaint with age over 40**

A complete medical picture nobody typed, in the hands of a stranger who needed it,
seconds after being asked. That is the third problem — *the context exists, it's just
never where it's needed* — closed.

---

## 8. Why the architecture is shaped this way

There is one rule underneath everything:

> **The agent holds no state.** Everything it knows, it fetched this turn.
> Everything it learned, it wrote this turn.

```
        parent's phone ──in──┐        ┌──out──► parent's phone
                             ▼        │
                      ┌──────────────────────┐
                      │  Twilio — one number │
                      └──────────┬───────────┘
                      ┌──────────▼───────────┐
                      │  Voice agent         │   ← holds NOTHING
                      │  two modes, no state │
                      └──────────┬───────────┘
                        7 tools over HTTPS
        ══════════════════════════▼══════════════════  ← THE MEMORY BOUNDARY
                      ┌──────────────────────┐
                      │  Care API            │
                      │  tools · rules ·     │
                      │  escalation · scorer │
                      └──────────┬───────────┘
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
          Database        Caregiver app       Handoff view
                                 │
                          WhatsApp / SMS
```

If memory lived in the conversation, a new call would be a new conversation and every
claim about continuity would be false. Pushing the boundary **below** the agent is what
makes continuity structurally true instead of asserted — and it is the only reason
resume-after-drop is possible at all.

Three consequences worth internalising:

1. **Tools always return HTTP 200.** A failure is `{ok:false}` in the body, never a
   non-2xx. A transport error makes the agent stall and the parent hears silence.
   Failure must be *data*, never *transport*.
2. **Every tool has a scripted fallback line.** The `escalate` fallback matters most:
   if the machine can't reach Shubh, the agent tells Sharma-ji to call him directly.
   A failed escalation never passes silently.
3. **The agent is one agent with two modes**, not two agents. A guardrail that exists
   in two places drifts.

---

## 9. What gets scored, and which piece earns it

| Parameter | The piece that earns it |
|---|---|
| **Job-to-be-done** | 12 checkable fields × 3 cold runs, ≥85% accuracy, nobody touching a keyboard |
| **Memory & Context** | Sessions (out→in) · channels (phone→app→WhatsApp→web) · tools (7) · handoffs (the link) · **governing business rules** (the rule string on screen). All five, literally |
| **Creativity** | Outbound exists to make inbound smart. One mechanism, not two features |
| **Impact** | 149M Indians 60+ · ~50% non-adherence · 36% with a migrant child · n=31 primary research |
| **Delight** | The 2 AM call that doesn't make you repeat yourself, and recovers without losing progress |
| **Revenue (track)** | One real ₹499 payment, from someone standing in the room, plus measured unit economics |

---

## 10. The five things that can kill this build

1. **`upsert_intake` batching to call end.** Kills resume, kills Memory L5, kills the
   best moment in the video. Write every turn.
2. **Caller ID not exposed as expected.** Build the ask-for-number fallback *first*.
   It always works. Wire the automatic path second.
3. **A safety violation on a recorded run.** Any FAIL invalidates that run. Score every
   transcript; never ship a FAIL.
4. **Nobody owning the video.** Only the top 3 demo live. For everyone else the
   recording *is* the product.
5. **A padded database.** They perform spot checks. Every row from a real call, or the
   parameter zeroes.

---

## 11. Where to go next

| You are | Read |
|---|---|
| Everyone, at 18:30 | `00-SHARED-T0.md` |
| Lane A | `LANE-A-VOICE.md` |
| Lane B | `LANE-B-API.md` |
| Lane C | `LANE-C-APP.md` |
| Lane D | `LANE-D-EVIDENCE.md` |
| Anyone asking "why" | `../PRD.md` |
| Anyone asking "how" | `../TRD.md` |
| Anyone asking "when" | `../IDEA_SCOPE.md` |
