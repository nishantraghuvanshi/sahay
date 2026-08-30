# Wireframe Specification

Reference for anyone building UI, API responses, or agent behaviour that surfaces in the
caregiver-facing product. It describes **what the wireframes actually say** — screen by
screen, component by component — plus the conventions needed to build new screens that
look and behave like they belong.

Source files (design-canvas HTML, open in a browser):

| File | Frames | Covers |
|---|---|---|
| [`wireframe/Medicine Care App Wireframes.dc.html`](../wireframe/Medicine%20Care%20App%20Wireframes.dc.html) | 19 (`1a`–`1s`) | Mobile, 320×660 phone frames |
| [`wireframe/Medicine Care App Wireframes — Web.dc.html`](../wireframe/Medicine%20Care%20App%20Wireframes%20—%20Web.dc.html) | 16 (`2a`–`2o`) | Desktop, 1160×730 browser frames (~1440 viewport) |

Frame IDs are anchors: `…dc.html#1f` jumps to the Home screen. **Cite frame IDs in
tickets, PRs and code comments** — they are the shared vocabulary. IDs are stable across
revisions; deleted frames leave gaps rather than renumbering (`1k`, `1l`, `1r`, `2i` are
gone — see §12). Screens inserted into an existing flow get a sub-ID: anchor `#1e2`,
displayed as **1E.2**.

---

## 0. Read this first — three caveats

1. **The product is Kinvox**, on every frame and every URL (`kinvox.app`), settled
   30 Aug. Earlier names — MediWatch, Sahay, briefly Voxikin — survive in older commits
   and stale screenshots; none is current. Voxikin especially must not reappear: it is
   the founder's company, and `[V]` rule 04 keeps it off screen.
2. **Scope is deliberately narrow.** The mobile file states it outright: *"Medicines,
   calls and what she said — no ordering, no mood scoring."* Pharmacy quotes, carts,
   checkout, refills and stock counting are **out**. Sentiment percentages, mood charts
   and wellbeing scores are **out**. What replaced them is a verbatim record of what the
   parent said, severity-tagged, always traceable to a call.
3. **Grey-box fidelity.** No brand colour, no illustration, and — for the newest screens
   — **no final copy**: consent lines are literally tagged `copy TBC`, and `1a`'s
   annotation says "Copy still to be written." Blue handwritten text (`.ann`) is a note
   to the builder; **it is never UI**.

The wireframes now line up closely with [`docs/TRD.md`](TRD.md): P1/P2/P3 priority with
its literal rule string, verbatim observations with severity, and the timed escalation
chain all appear in the UI. §10 lists what still does not.

---

## 1. Product model the wireframes assume

- **One caregiver account, one parent** (mobile). The desktop alt `2m` shows what
  multi-parent looks like when that assumption breaks.
- **The parent installs nothing.** Every screen in both files is the *caregiver's*
  screen. The parent's entire interface is answering a phone call.
- **The agent calls; the caregiver watches and intervenes.** Every primary action is
  either "confirm what happened" (Mark taken) or "step in myself" (Call Mom Now).
- **The app never dials.** Call buttons open the phone dialler with the number
  pre-filled — the caregiver presses the green button. Only the agent's own calls are
  placed by the service, from its end.
- **Capture, never interpret.** The app shows what she said and which rule fired. Never
  a diagnosis, a mood score, or a percentage that cannot be traced back to a sentence.
- **Calling is gated twice** (§8, rules 1–3): the caregiver signs off the schedule, and
  then an intro call must happen and the parent must agree on it. Dose calls start only
  after both.
- No commerce anywhere. Timezone IST; agent languages Hindi (default), English, Marathi,
  Punjabi, + more. Example parent "Mom · Sushila Devi · 71 · Pune", caregiver "Rohit",
  escalation contact "Priya (sister)", doctor "Dr. Mehta", neighbour "Mrs Rao".

---

## 2. Design system

### 2.1 Tokens

| Token | Value | Used for |
|---|---|---|
| Canvas | `#f0eee9` | Page background behind frames (canvas only, not in-app) |
| Ink | `#1a1a1a` | Text, borders on emphasis, filled buttons, active nav, "taken" dots |
| Surface | `#fff` | App background, inputs, chips, bottom sheet |
| Card | `#fafaf8` | Card fill (`.c`) |
| Card border | `#d8d8d4` | Card and input outlines |
| Divider | `#e4e4e0` | Structural rules (header/footer/pane edges) |
| Divider light | `#eeeeea` / `#f0f0ec` | Row separators inside tables and lists |
| Muted fill | `#dedede` | Text-placeholder bars (`.g`) |
| Text secondary | `#6d6d6d` | Body support text |
| Text tertiary | `#8d8d8d` | Labels, metadata, timestamps |
| Text placeholder | `#9a9a9a` | Empty input text, disabled rows |
| Selected row | `#f6f6f4` | Table row selection, banner strips |
| Quote highlight | `#ededea` | The transcript line that triggered a flag |
| Annotation | `#2a78d6` + Patrick Hand | **Builder notes only — never ship** |

One accent: black. Severity, selection, "now" and "taken" all read as ink-on-white, with
weight and border thickness doing the work.

**Disabled** is `opacity: .4`–`.45` on the element (buttons, locked step cards, stopped
table rows). It appears on every gated CTA in the flow, so build it as a real state, not
a one-off style.

### 2.2 Scale

Mobile frames are 320×660 with an 11px body; desktop frames are 1160×730 (the newest are
1160×640) with an 11px body. Treat these as **proportions, not literal pixel values**:

- Mobile: frame → 390pt device, i.e. ×1.22. Body 11 → 14, screen title 12.5 → 15,
  hero number 20 → 24, micro-label 8.5 → 10–11.
- Desktop: frame 1160 → 1440 content width, i.e. ×1.24. Body 11 → 14, `h1` 15 → 19.
- Never render the 8.5px `.lbl` at 8.5px in production. It is a caps micro-label;
  10–11px with `letter-spacing: .09em` is the intent.

Radii: 6px inputs · 7px buttons/nav · 8px cards/tables · 10px desktop frame ·
16px bottom-sheet top corners · 99px chips, avatars, toggles, dots. Gaps: 6px within a
row group, 8–9px between rows, 11–12px between cards, 16–18px page padding.

### 2.3 Component inventory

| Class | Component | Notes |
|---|---|---|
| `.ph` / `.dt` | Device frame | Mockup chrome only; not a component |
| `.sb` / `.brow` | Status bar / browser chrome | Mockup chrome only |
| `.tp` / `.hd` | Screen header | Mobile: back · title · trailing label. Desktop: 48px, title + stepper/actions + search |
| `.tb` | Tab bar | Mobile, **4 tabs**, `.on` = active |
| `.sd` | Sidebar | Desktop, 186px, logo · parent switcher · nav · footer widget |
| `.nv` | Nav item | Icon + label + optional `.cnt` count badge; `.on` = active |
| `.c` | Card | Default surface for every grouped block |
| `.c` + `border:1.5px solid ink` | **Primary card** | "The one thing here" — next dose, critical alert, selected option, active step |
| `.c` + `border-left:3px solid ink` | **Attention card** | Secondary emphasis — needs review, cited rule, consent block, conflict, degraded state |
| **Step card** | `.c` + numbered `.tag` + trailing `.dot` | See §2.5 |
| **Option card** | `.c` + leading `.dot` + title + sub-line | Radio-style choice (`1E.2` intro-call timing). Selected = primary card + `.dot.k` |
| **Consent row** | `.dot.k` / `.dot.x` + sentence | Checkbox in dot form; ticked = `.dot.k`. Always inside an attention card, with a "N left" counter |
| **Bottom sheet** | White panel, 16px top radius, grab handle, `box-shadow:0 -6px 18px` over a 35%-opacity page | Mobile only (`1E.2 sheet`) |
| `.r` / `.sp` / `.vsp` | Row / spacer-right / spacer-down | Layout primitives |
| `.btn` | Primary button | Filled ink; one per screen region. `opacity:.4/.45` = gated |
| `.ob` | Secondary button | Outlined ink |
| `.chip` | Chip | Filter, toggle, inline action, tag input. `.on` = selected |
| `.tag` / `.tag.o` | Badge | Filled = severity/state/step-reached (`critical`, `red`, `P1`, `missed`, `1`). Outlined = category or not-yet (`watch`, `agent`, `edited`, `stopped`, `4`) |
| `.lbl` | Micro-label | 8.5px caps, tertiary. Section/column headers, `copy TBC` markers, the `none` severity |
| `.in` | Input | Also read-only display fields and single OTP digit boxes |
| `.g` | Placeholder bar | Marketing copy, skeletons |
| `.dot` | Status dot | See §2.4 |
| `.im` | Image/media placeholder | Hatched fill; dashed border = drop target |
| `.av` | Avatar | 18/20/26/28/34/52px |
| `.tbl` / `.th` / `.tr` / `.tr.sel` | Data table | Desktop only |
| `.li` / `.li.sel` | List item | Desktop split-pane list |
| `.pane` / `.pane-b` | List pane / detail pane | Desktop master–detail |
| Toggle | 32×18 pill, 14px knob | Inline, no dedicated class — build one |

### 2.4 Status dots

| Mark | Meaning |
|---|---|
| `.dot.k` filled ink | Taken / done / confirmed / delivered / **consent ticked** / step complete / option selected |
| `.dot.x` outlined ink | Missed / negative / **unticked consent** / step needing action now |
| `.dot` grey | Upcoming / not yet / pending / locked step / unselected option |

The same three marks carry dose status, delivery state, step progress, radio selection
and checkbox state. Do not invent a fourth.

> One leftover: `2e`'s "Last check-in" card still renders a five-dot row labelled `calm`.
> That is the old sentiment meter, removed everywhere else with mood scoring. Drop it or
> replace it with the call's highest observation severity.

### 2.5 Progressive step cards

`1a` / `2a` introduce a pattern the whole onboarding uses. Each step is a card with a
numbered `.tag`, a caps label, and a trailing dot:

| Step state | Tag | Dot | Card |
|---|---|---|---|
| Complete | filled | `.dot.k` | plain card, values shown as real text (`color:#222`) |
| Active | filled | `.dot.x` | **primary card** (1.5px ink border) |
| Locked | outlined | `.dot` | `opacity:.45`, fields show placeholder dots only |

Each step unlocks the next. Do not let a user jump ahead.

### 2.6 Copy rules visible in the wireframes

- **Verbatim quotes over summaries.** Alerts and the record lead with what the parent
  actually said — `"Chest feels tight when I walk."` Matches TRD §5 `log_observation`.
- **Cite the rule, not the diagnosis.** `1i` / `2g` show a `P1` badge above the literal
  string `rule: chest complaint with age over 40`, then *"Triggered on the words she
  used. No interpretation, no diagnosis."*
- **No score without a sentence behind it.** `1s` / `2j`: *"no mood score, no percentage.
  A number nobody can trace back to a sentence is not evidence."*
- **Buttons say the destination**, not "Next": `Upload Prescription`, `Approve Schedule`,
  `Continue to Consent`, `Continue on the app`, `Save and Continue`.
- **Consequences, not settings language.** `2b`'s live call-script preview and its
  "Won't ever" list (no medical advice, no penicillin mention, no calls after 8 PM).
- **Every error offers a manual path** (`2o`) — "Type it in" always exists.
- Second person, present tense, no exclamation marks. Timestamps are human ("6 min ago",
  "Yesterday", "7:41").
- Consent copy is **not final** — every consent line carries `copy TBC`. Legal/clinical
  review owns those strings, not the builder.

---

## 3. Information architecture

### 3.1 Mobile — 4 tabs

```
Home · Calendar · Alerts · Calls
```

Settings sits behind the ⚙ in the Home header. "What Mom said" (`1s`) is reached from
Home / Alerts / a call. The medicine editor (`1G.2`) is reached from Calendar.

### 3.2 Desktop — sidebar

```
Dashboard · Calendar · Alerts(3) · Calls(2) · Prescriptions · What she said
─────
Settings
```

Sidebar top: logo, then a parent switcher card. Sidebar bottom: a context widget that
changes per section — agent next call (`2e`), calendar filters (`2f`), escalation chain
(`2g`), next scheduled calls (`2h`), weekly digest (`2j`) — then the caregiver's row.

### 3.3 Onboarding is four steps

```
1 · Parent  →  2 · Prescription  →  3 · Schedule  →  4 · Consent
```

Step 4 is new. The desktop stepper shows all four; its header reads **"nothing has
called Mom yet"** until the intro call is scheduled.

### 3.4 Routes (from the browser chrome in the web frames)

| Route | Frame |
|---|---|
| `/` (marketing + login) | `2a` |
| `/setup/meet` | *no frame — added after the wireframes: the in-browser voice playground a caregiver meets right after signup* |
| `/setup/parent` · `/setup/prescription` · `/setup/schedule` | `2b` · `2c` · `2d` |
| **`kinvox.app/setup/consent`** | **`2D.2`** |
| `/home` | `2e`, alts `2l` `2n` |
| `/calendar` | `2f` |
| **`kinvox.app/medicines/edit`** | **`2F.2`** |
| `/alerts` · `/alerts/{id}` | `2g` |
| `/calls` | `2h` |
| `/wellbeing` (renders "What she said") | `2j` |
| `/settings/{section}` | `2k` |
| `/console` (multi-parent alt) | `2m` |

Every frame now uses `kinvox.app`. `/wellbeing` is a stale path for a screen now called "What
she said" — rename to `/said` or `/record`.

### 3.5 Mobile → desktop mapping

| Mobile | Desktop | Transformation |
|---|---|---|
| `1a` login | `2a` | Same four steps; desktop wraps them in a marketing hero |
| `1b` profile | `2b` | One column → two columns + live script preview |
| `1c` upload + `1d` OCR | `2c` | Two screens → one, side by side |
| `1e` approve | `2d` | Stacked cards → editable spreadsheet with bulk edit |
| **`1E.2` + `1E.2 sheet` consent** | **`2D.2`** | Mobile raises the time picker as a bottom sheet; desktop keeps it inline |
| `1f` home | `2e` | Stack → day table + persistent attention rail |
| `1g` calendar | `2f` | Day timeline → week grid, drag to reschedule |
| **`1G.2` edit medicines** | **`2F.2`** | Card list → table with pending-change states |
| `1h` list + `1i` detail | `2g` | Push navigation → master–detail split pane |
| `1j` calls | `2h` | Log → log + searchable transcript + "what this call produced" |
| `1m` settings | `2k` | Row stack → section rail + two-column page |
| `1s` what she said | `2j` | Card list → table with severity column + repeated-words panel |

**Rule:** desktop never adds a *capability* mobile lacks (except transcript search,
drag-reschedule, bulk edit, and multi-parent). It removes navigation steps.

---

## 4. Mobile screens

### `1a` Login / signup — phone → OTP → email → OTP
Full-bleed, no header. Logo → headline "Keep an eye on your parent's meds" → one copy
bar → **four step cards** (§2.5):

1. **Phone number** — complete. `+91 · 98765 43210`
2. **Verify phone** — complete. Six single-digit `.in` boxes showing `4 1 9 2 0 7`,
   footer "Verified" + `resend in 0:24`
3. **Email address** — active (primary card). `rohit@gmail.com` + **`Send OTP to email`**
4. **Verify email** — locked, `opacity:.45`, six empty boxes

Footer: *"By continuing you agree to Terms & the consent to place automated voice calls
to your parent."*

**No social login.** Google and Apple were removed; the annotation reads *"Four steps,
each unlocking the next. Copy still to be written."* Language selection is no longer
here — it moved to the parent profile.

### `1b` Add parent profile — step 1/4
Header: ← · "Who are we caring for?" · `1/3` *(stale — should read 1/4)*.

Fields: avatar + Name + `photo` · Age · Relation · **Parent's phone — the agent calls
this** · Known conditions (chips) · Allergies & things to avoid (chips) · **Language the
agent should speak** — `हिन्दी Hindi` selected, `English`, `मराठी Marathi`, `ਪੰਜਾਬੀ`,
`+ more` · free-text "Anything to keep in mind" (*hard of hearing on the left ear · gets
confused after 9 PM · won't take tablets without food · call her "Amma"*).

Then: **Allow agent check-in calls** (toggle, on) + call window (9 AM – 8 PM). Then
optional escalation contacts (family / doctor / neighbour chips, explicitly skippable).

Footer: a requirement line **"Name, age, relation, phone, language required · 2 left"**
above a **disabled** `Upload Prescription`. Annotation: *disabled until every required
field is filled → goes to `1c`. Escalation contacts don't count.*

> The parent-consent toggle that used to live here has moved to the dedicated consent
> step `1E.2`.

### `1c` Upload prescription — step 2/4
Dashed drop target ("Tap to scan, or drop a file · JPG · PNG · PDF · up to 10 pages") ·
Camera / Gallery / Files · "Added (2)" list with thumbnail, filename, progress, ✕ · tip
card · CTA **Analyse prescription**. The same uploader is reused whenever a new
prescription arrives later.

### `1d` OCR analysis progress
Blocking screen, "Reading prescription… · step 3 / 4". Page preview with detected boxes.
Four-step checklist with timings: enhance & deskew (0.4s ✓) · OCR (1.1s ✓) · matching
medicines to the drug database (running) · building dose schedule (pending). Plus "Found
so far" chips (`Atorvas… ?` for an uncertain match) and a `2 unclear` badge.

CTA **`Approve Schedule`**, enabled once matching finishes → `1e`.

### `1e` Approve schedule — step 3/4
Banner: `check · 2 rows unclear — fix these before you sign off`.
Legend row: *Dose · frequency · times · food rule · end date*.

One block per medicine: name + form/food rule · dose per dose · ✎ · chip row of
frequency · each time · end date. Unclear rows get the attention-card treatment (grey
fill, left rule, `unclear` badge, guessed expansion as subtitle). No stock fields.

Footer chips: `+ Add medicine` · `Set all end dates` · `View as calendar`.

Sticky bottom: **unchecked confirmation** — *"I confirm these 5 medicines, doses and
timings are correct — Nothing is called about until you tick this."* — above a
**disabled** **`Continue to Consent`**. Annotation: *without the tick the button does
nothing → `1E.2`.*

### `1E.2` (`#1e2`) Parent consent — the intro call, then consent
Header: ← · "Before we call Mom" · `last step`.

Lead: **"First we ring Mom once to introduce ourselves"** — *"No medicines on this call.
We say who we are, that you set this up, and ask if she is happy to be called."*

**When should that call happen?** — three option cards:
1. **Call Mom now** (selected, primary card) — "We dial her in the next minute or two."
2. **Schedule the call for later** — "Pick a time she is usually free." + `Today 6:30 PM ▾`
   chip, which opens the bottom sheet `1E.2 sheet`
3. **"I'll tell her myself first"** — "We wait until you say she is ready." Carries an
   outlined `3rd option?` badge — **an open design question, not a settled option**

**Your consent** (attention card) — three mandatory lines, each with a `copy TBC` marker:
- ● I confirm Mom knows Kinvox will call her
- ● I consent to these calls being recorded and transcribed
- ○ I understand Kinvox never gives medical advice

with "All three are mandatory · 1 left".

Note card: *"We call Mom from our end — nothing dials from your phone."*
Footer: *"All calling functionality begins only after this intro call and a final
approval from your mom."* + **disabled** `Continue on the app`.

Annotation: *the intro call is the gate — dose calls do not start until Mom says yes on
it.*

### `1E.2 sheet` (`#1e3`) Scheduling the intro call
The same screen at 35% opacity behind a **bottom sheet**: grab handle · "When is Mom
usually free?" · ✕ · **Day** chips (`Today` selected / Tomorrow / Pick a date) · **Time**
chips (10:00 AM / 12:30 PM / 4:00 PM / `6:30 PM` selected / Custom) · a card stating
*"Her call window: 9 AM – 8 PM · Times outside the window are hidden"* · CTA
`Set 6:30 PM today`.

Sheet only — the choice writes back into option 2 on `1E.2`.

### `1f` Home — next dose leads
Header: avatar · "Mom" · "On track today · 3 of 5 taken" · ⚙.

1. **Primary card**: `Next dose · in 22 min` + `2:00 PM` → "Metformin 500 mg" → "1 tablet
   · after lunch" → `Mark taken` + `Call Mom` → `Schedule a call for this dose later` →
   divider → *"Agent will call at 2:05 PM if unconfirmed"* + `edit`.
2. Attention card: `1 alert` · "Missed 6:30 AM Thyronorm" · ›
3. **Last check-in call** (now an attention card): `9:12 AM` · duration `1:04` ·
   `transcript` · the quote, weighted: *"Took them morning once. Knee hurts a bit."*
4. **"Today so far · since 6 AM"** + `Open calendar` — a chronological event list, one
   row each: dot · time · what happened · trailing chip/label —
   `7:41 Insulin 8 u confirmed · on call` / `8:04 Metformin · Amlodipine confirmed · on
   call` / `6:30 Thyronorm missed — strip not found` + `fix` / `9:12 Check-in call
   answered · 1:04` / `2:00 Metformin due · 2 doses still to come`.
   Footer line: **"3 of 5 doses · 1 call · 1 alert — so far today"**.

Annotation: *the whole-day summary rebuilds on every visit — everything since 6 AM in one
block, so you never scroll the calendar to find out what happened.*

> The rows are not in strict time order in the frame (7:41 and 8:04 precede 6:30). Sort
> chronologically when building.

### `1g` Calendar — day timeline
Header: "August 2026" + `Day ▾`. Week strip (M–S, one dot per day, today inverted). Body:
time-gutter timeline, one card per dose; same-time medicines stack in one slot. States:
`missed` badge + outlined dot; taken shows the confirmation time (7:41); the current slot
gets a `now` chip and heavier border.

Footer: **`Edit these medicines`** and **`Upload new prescription`** (two equal outlined
buttons) above the legend. Annotation: *both routes land on the same editor (`1G.2`) —
one opens on the medicine list, the other on the uploader.*

### `1G.2` (`#1g2`) Edit medicines / upload a new prescription
Header: ← · "Change medicines" · `5 meds`. Segmented control: **Edit medicine** |
**Upload prescription**.

Body: one card per medicine (selected one is a primary card, with frequency and time
chips + `+ time`), then `+ Add medicine` / `Stop a medicine` · divider · **"Attach the
new prescription" · `optional`** dashed drop target.

Then a mandatory attestation (attention card, unticked), verbatim:

> **"Hey, I am fully aware of the changes that I am making in this calendar, and these
> changes have been explicitly advised by our doctor."**

CTA **`Save and Continue`**, disabled until ticked. Annotation: *the upload is optional;
the consent is not.*

### `1h` Alerts feed
Header: "Alerts" + `Mark all read`. Two filter rows: **time range** (Day / Month / Year /
All time) and **category with counts** (All 5 / Critical 1 / Meds 3 / Calls 1).

Alert cards, most severe first — badge + relative time + headline + one line of context +
inline actions:

| Type | Badge | Actions |
|---|---|---|
| Critical | filled `critical` + primary card | `Call Mom now` · `Open detail` |
| Missed dose | outlined | `Mark taken` · `Reschedule` |
| No answer | outlined | `Retry now` · `Escalate to Priya` |
| Missed dose (older, unconfirmed) | outlined | `Mark taken` · `Schedule a call` |

Annotation: *date filter above severity — "did anything happen this month?" is the
question people actually arrive with.*

### `1i` Alert detail — verbatim transcript + cited rule
Title + meta (`Today · 1:35 PM · agent call #214 · 2 min 11 s`) + `critical`.

1. **Why this was flagged** (attention card) — `P1` badge, the literal string
   **`rule: chest complaint with age over 40`**, then *"Triggered on the words she used.
   No interpretation, no diagnosis."*
2. **Transcript excerpt** — speaker badges (`agent` outlined / `mom` filled),
   `Play audio ▶`, "full transcript ›".
3. **Told to** — `● You · WhatsApp — 1:37 PM ✓` / `○ Priya · in 9 min`.
4. **Context from the record** — "BP meds taken on time · 3 dizziness mentions this week".

Actions, each carrying the identity it will dial:
- **`Call Mom Now`** `+91 90••• •••••` (primary)
- **`Call Doctor Now`** `Dr. Mehta`
- **`Escalate to Priya`** `sister`
- `Mark resolved`

Annotation: *these three open the phone dialler with the number already in — you press the
green button, nothing dials on its own.*

> `Copy handoff link` has been removed from this screen. The handoff concept now survives
> only on web (`2h`'s "handoff link created" chip, `2m`'s per-person links).

### `1j` Calls & messages
Segmented: **Agent calls** | **Messages**. Each row: `agent`/`you` badge · timestamp ·
duration or `no answer` · one-line outcome · `Transcript` / `Audio ▶` · `alert` badge if
it produced one. Unanswered rows dimmed, "Retried twice · voicemail left". Below: messages
preview. Header: `+ check-in now`.

Annotation: *every call keeps its transcript. What she said is the record — no mood score
sitting on top of it.*

### `1m` Settings
Parent card ›. **Voice agent**: check-in calls toggle · times per day (3) · call window ·
voice & language ("Hindi · warm") · retry ("2× / 10 min") · record & transcribe.
**Alert rules**: Missed dose · No answer · Unwell · Double dose · Emergency word (on),
Sleep change (off) + "Notify me by: Push + SMS".
**Escalation**: ordered contacts with conditions ("Priya — after 15 min", "Dr. Mehta —
critical only") + add. **Account**: Prescriptions & documents ›.

### `1s` What Mom said — verbatim, newest first
Header: ← · "What Mom said" · `Month ▾`. Filters: `All 14` · `Red 1` · `Watch 4`.

One card per utterance, newest first: severity (`red` filled + attention card / `watch`
outlined / `none` plain label) · the quote verbatim · provenance (`Call #214 · escalated
to you`) + `Transcript`.

Actions: `Call Mom now` → `Share this week with Priya`.

Annotation: *her words, timestamped, with a severity chip — no mood score, no percentage.*
This is the UI for `observations` (verbatim text + severity none/watch/red).

### Alternates — decide before building
| Frame | Direction | Trade-off as written |
|---|---|---|
| `1n` | Home = attention-first: critical → missed/no-answer → next dose → today → "Last thing she said" | Calmer on good days, louder on bad ones. Compare with `1f` |
| `1o` | Hub home, no tab bar; six tiles — Alerts, Calendar, Calls, What she said, Care record, Prescriptions — + "Trigger a check-in call now" | Fewer, bigger targets; costs a tap to reach Calendar/Alerts |
| `1p` | Alerts as one conversational timeline | Better story, worse triage than `1h` |
| `1q` | Camera-first intake, results in a sheet (merges `1c`+`1d`) | Fastest, harder to fix a bad scan |

---

## 5. Desktop screens

Shell for every signed-in screen: browser chrome → sidebar (§3.2) → main (48px header) →
content area, 16×18px padding, columns with 12–16px gaps.

### `2a` Landing + login — phone → OTP → email → OTP
Marketing nav (How it works · Pricing · For families · Log in · Get started) → split body:
left = hero headline, copy bars, `Start free` + `Watch 90-sec demo ▶`, three value cards
(Scan the prescription / Agent calls your parent / **You only hear what matters — missed
dose, no answer, anything she says that needs you**), product screenshot; right = 376px
auth column carrying **the same four step cards as `1a`**, then the automated-calls
consent note.

Annotation: *phone → OTP → email → OTP, same four steps as mobile `1a`. **No social login
for now.***

### `2b` Onboarding 1 — parent profile
Stepper (1 · Parent / 2 · Prescription / 3 · Schedule / 4 · Consent) + "saved just now" +
Exit. Left: identity row · phone + city/timezone · conditions and allergies side by side ·
**Language the agent should speak** chips · keep-in-mind textarea · agent card (toggle +
call window + voice) · escalation card marked `optional` with one contact and
`+ add family member`.

Footer: **"Name, age, relation, phone and language required · 2 left"** · `Back` ·
**disabled `Upload Prescription`**.

Right (300px), web-only: **Preview · first call script** — the line the agent would say in
the chosen language and tone, "Uses" chips showing which fields shaped it (`"Amma"`,
`after food`, `Hindi`, `speak slowly`), and a **"Won't ever"** list (give medical advice ·
mention penicillin drugs · call after 8 PM).

### `2c` Onboarding 2 — upload with OCR beside it
Left: large dashed drop zone (also "paste from clipboard") + `Browse files` · alternate
inputs (Scan with phone (QR) / Import from email / Google Drive) · uploaded files with
size, progress, `read ✓` · tip.
Right: live OCR panel — "Reading · step 3 of 4" · page preview where **detected dose lines
are boxed and clicking a box jumps to that row** · the four-step checklist · "Found so
far" chips + `2 unclear` · allergy cross-check (*"Penicillin allergy on file — nothing in
this prescription conflicts."*) · CTA **`Approve Schedule`**.

### `2d` Onboarding 3 — approve schedule as a spreadsheet
Banner: "2 rows unclear — fix these before you sign off" + `Jump to first` /
`View as calendar`.

Table: **Medicine · Dose · Frequency · Times (chips, +) · Food rule · End date · Alerts
(dot) · ✎**. Unclear rows selected-styled with an inline-editable cell. Bulk row:
`+ Add medicine` · `Set all end dates` · `Bulk edit times` · "shift-click to select a
range".

Below: **Resulting day** (every slot as a chip + "6 dose events · 3 agent check-in calls
placed around them") and a **conflict** card (*Thyronorm 06:30 needs an empty stomach* →
`Shift to 06:00` / `Keep`).

Footer row: annotation · **sign-off checkbox** (attention card, unchecked) · `Save draft` ·
**disabled** `Approve & start calling`. Annotation: *until it is ticked the button does
nothing → `2D.2`.*

### `2D.2` (`#2d2`) Parent consent — the intro call, then consent
Route `kinvox.app/setup/consent`. Stepper shows **4 · Consent** active; header note
**"nothing has called Mom yet"**.

Left (flex 1.35): **"First we ring Mom once to introduce ourselves"** — *"No medicines on
this call. We say who we are, that you set this up, and ask whether she is happy to be
called. Dose calls start only if she says yes."*

Then the same three option cards as mobile, but with the picker **inline** inside option
2: `Day` chips (Today / Tomorrow / Pick a date) and `Time` chips (10:00 AM / 12:30 PM /
4:00 PM / **6:30 PM** / Custom), with *"Only times inside her 9 AM – 8 PM window are
offered."* Option 3 carries the `3rd option?` badge. Bottom note: *"We call Mom from our
end — nothing dials from your computer or phone."*

Right (330px): **Your consent** (attention card, "1 left") with the three mandatory
`copy TBC` lines · **What happens next** — `● We call Mom · today 6:30 PM` → `○ She agrees
on that call` → `○ Dose calls begin next morning 6:30` · the closing line *"All calling
functionality begins only after this intro call and a final approval from your mom."* ·
**disabled** `Continue on the app`.

### `2e` Dashboard
Header: "Today · Wed 20 Aug" · `On track` · search · `Call Mom` · `+ Add medicine` ·
notifications.

Left column: primary next-dose card (`Mark taken` · `Snooze 30 min` · `Call Mom` · `Skip
with reason` + "agent calls at 2:05 if unconfirmed") → "Today's doses" table (Time ·
Medicine · Rule · Status · Action; status carries provenance: `7:41 · by Mom`, `on call`,
`missed`, `upcoming`) → adherence, last 14 days + `Export CSV`.

Right rail (326px) — "Needs you":
- Critical alert card (verbatim quote + `Call Mom now` / `Open`)
- Attention card combining `missed` and `no answer` with `fix` / `retry`
- **Last check-in** — now an attention card with duration, `Transcript`, and the quote
  weighted (still carries the legacy dot row — see §2.4)
- **"Today so far · since 6 AM"** — the same chronological event list as mobile `1f`,
  headed "3 doses · 1 call · 1 alert"
- **What she said this week** — `1 red`, the red quote, "4 more entries", `View all`
- **Care record** — "5 medicines · 1 priority" + `Open` · allergies · doctor + `Call`

### `2f` Calendar — week grid
Header: month · ‹ Today › · Day/Week/Month/Agenda · "17–23 Aug · 86% taken" · `+ Add
dose`. Day columns across, time rows down; each cell a card with that slot's medicines and
status dots. Future days dimmed, missed cells get the left rule + badge, current cell a
heavy border + `now`.

Footer: **`Edit these medicines`** · **`Upload new prescription`** · legend ·
`Print / share PDF`. **Drag a card to another cell to reschedule that dose; shift-drag
moves the whole series.** Annotation: *either button opens the editor (`2F.2`).*

### `2F.2` (`#2f2`) Edit medicines / upload a new prescription
Route `kinvox.app/medicines/edit`. Header: ← · "Change medicines" · segmented **Edit
medicine** | **Upload prescription**.

Left: a table of current medicines with **pending-change states** — an edited row is
selected-styled with an `edited` badge and inline-editable cells; a stopped row is
`opacity:.5` with a `stopped` badge and `—` values. Bulk row: `+ Add medicine` ·
`Stop a medicine` · "3 changes pending".

Below it, **"What changes for Mom"** — a plain-language diff as chips:
`21:00 → 21:30 Metformin` · `Atorvastatin dropped` · `5 → 4 medicines`.

Right (320px): **"Attach the new prescription" · `optional`** drop target, the uploaded
file with `read ✓ · 3 medicines matched`, then the same mandatory doctor-advice
attestation as `1G.2`, then **disabled** `Save and Continue`.

### `2g` Alerts — master–detail
Left pane (330px): filter chips with counts then list items; resolved items dimmed;
selected item styled.

Right pane: title + meta + `critical` + `Copy link` + ‹ › paging → action row —
**`Call Mom Now` +91 90••• ••••• · `Call Doctor Now` Dr. Mehta · `Escalate to Priya` ·
`Mark resolved`** — with keyboard hints "j / k to move · r to resolve" → two columns:
- Wide: **Why this was flagged** (`P1` + the rule string + "No interpretation, no
  diagnosis") · full transcript with per-line timestamps, triggering line highlighted ·
  audio scrubber.
- Narrow (250px): **Told to** · **Context** checklist · **Activity** timeline (agent
  flagged 1:37p · push+SMS to you 1:37p · Priya notified in 9 min) · "Note for the family".

### `2h` Calls & messages
Left pane (300px): **transcript search** + filters (Agent / Mine / Messages / Flagged);
rows carry badge, time, duration, outcome, `alert` badge where one was produced.

Right pane: call header (`Check-in call #214 · Hindi · agent "warm"`) + `Call Mom` +
`Share with Priya` → **What this call produced** — outcome chips (`2 doses confirmed` ·
`1 observation · red` · `1 escalation · P1` · `handoff link created`), the rule string and
when it was written, `Open in record` → transcript with timecodes and a Hindi/English
toggle → right column: **What the call achieved**, **Topics detected**, Messages preview.

### `2j` What she said — verbatim, severity-tagged, newest first
Header: date range · `Red + watch only` · `needs attention` · `Share with Priya` ·
`Export PDF for doctor`.

Left: summary primary card ("14 things she said · 1 red · 4 watch" + *"Nothing is
summarised or scored."*) → table **When · Severity · What she said · Call · action** →
**Words that repeat** (`sleep 4×`, `knee 2×`, `quiet / alone 3×`, `grandson 5×`,
`chest 1×`) with *"tap one to see every line it appears in"* → **This week** (Doses
confirmed 31 of 36 · Calls answered 16 / 18 · Escalations 1 · P1).

Right (320px): **Needs a look** quotes with repetition counts + `Play all` → **Suggested**
actions → `Call Mom now` · `Add daily chat call` · `Tell Priya`.

### `2k` Settings
Section rail: **Parent** (Profile & conditions · Medicines & schedule · Prescriptions) ·
**Agent** (Calls & voice · Alert rules · Escalation) · **Account** (Family & access ·
Notifications · Billing · Privacy & data).

"Calls & voice", two columns:
- Calls: enable · calls per day (2/3/4/Custom) · call window · **offset from a dose
  (+5 min)** · retry (2× / 10 min) · leave voicemail. Voice: language + fallback · tone ·
  speed · **"Calls her: Amma"** + `Preview ▶` · record & transcribe (*"Mom is told on the
  first call"*). **Do not call** windows (temple 6–7 AM · Sunday afternoon).
- Alert rules: which events notify · missed-dose threshold (30 min) · channels ·
  **quiet hours for me** · **critical ignores quiet hours**. **Escalation chain**,
  numbered 1–4 with conditions and access level. **Data**: keep recordings 90 days ·
  export everything · delete account & data.

Header: `Test call to me` · `Save`.

### Alternates
| Frame | Direction | Trade-off as written |
|---|---|---|
| `2l` | "Quiet wall" dashboard — icon-only 64px rail, one sentence centred, two status chips, three actions, 14-day bar | Dense `2e` wins for daily managers; quiet wins for people who dread opening the app |
| `2m` | Multi-parent console — row per person (doses as dots · next dose · last call · **last said** · needs you · action) + combined alert feed + cross-parent stats + **"3 read-only links · no login"** | Where a second parent or a family-manager tier stops being painful. **Row = person, not medicine** |
| `2n` | Top nav instead of sidebar, three equal columns | Frees ~190px; costs the parent switcher and the peripheral alert count. Sidebar scales to `2m`, top nav does not |
| `2o` | **States** — build these | See §6 |

---

## 6. States (`2o`) — required for every screen

| State | Spec |
|---|---|
| **Empty** | Dashed card, icon, "No medicines yet", one line of what happens next, `Add prescription`, secondary `Enter manually instead` |
| **Loading** | **Skeleton, never a spinner.** Grey bars in the final layout's shape — "layout is stable before data lands, no jump" |
| **Degraded — agent can't reach parent** | `agent offline` + since-time, "4 calls have not connected", plain cause list, then the consequences: **doses tracked as "unknown", not missed**, and "Priya notified at 6:35 PM". Actions: `Call Mom yourself` · `Try another number` · `Ask neighbour` |
| **Error — OCR failed** | `couldn't read`, "We got 2 of 5 lines", blurred preview, specific cause, three recoveries (`Retake photo` / `Crop & retry` / `Type it in`), and *"Nothing is saved until you approve the schedule."* |

Two rules generalise: **an unreachable parent produces `unknown`, never `missed`**, and
**every error offers a manual path.**

Not yet drawn, and now needed: the state after the intro call — **awaiting Mom's consent**
(scheduled but not yet placed), and **Mom declined**.

---

## 7. Data the wireframes require

Mapped to [`docs/TRD.md`](TRD.md) §3 where a table already exists.

| UI need | Existing | Gap to add |
|---|---|---|
| Caregiver identity, phone + email both verified | `caregivers` | `phone_verified_at`, `email_verified_at`, OTP issue/resend state — the login is a four-step state machine, not one form |
| Parent identity, conditions, allergies, language, honorific, sign-off, pause | `patients` | photo, relation, timezone, "keep in mind" free text, do-not-call windows, required-field completeness |
| Medicines, dose, slots, food rule, priority flag | `medications` | end date, per-medicine alerts on/off, unclear flag, OCR source ref, **`stopped` state**. (`stock_count` now unused) |
| Dose status incl. provenance and confirmation time | `dose_events` | `unknown` status, `skipped_with_reason`, actor (parent on call / caregiver in app), snooze |
| **Caregiver consents** — three booleans + when + which copy version | — | `consents` table. Copy is `copy TBC`, so **version the strings** and store which version was agreed |
| **Intro call** — the pre-flight call and its outcome | — | A call of type `intro`, its scheduled time, and a `parent_consented` outcome that gates the scheduler. See §8 rules 2–3 |
| **Schedule change log with attestation** | — | Each edit batch: the diff ("21:00 → 21:30 Metformin", "Atorvastatin dropped"), who made it, and the doctor-advice attestation ticked |
| Call log, duration, transcript, language, direction | `call_sessions` | audio URL, voicemail flag, retry count, per-call outcome rollup, topics detected |
| Verbatim quotes with severity `none`/`watch`/`red` | `observations` | word-frequency rollup; link observation → alert |
| Priority `P1`/`P2`/`P3` + literal rule string | `intake_records` | render it directly — never an empty rule |
| Escalation with cited rule, channel, delivery status | `escalations` | scheduled-but-not-yet-sent ("Priya · in 9 min"), per-contact trigger config and ordering |
| Handoff link | `handoffs` | now surfaced only on web (`2h`, `2m`) — mobile dropped the action |
| Alerts feed | — | **`alerts` table**: type, severity, source, headline, read + resolved state, actions taken |
| Prescriptions, pages, OCR result, confidence | — | `prescriptions` + pages + extracted rows with confidence, so `unclear` is data, not a guess |
| Agent config (per-day count, window, offset, retries, tone, speed, name, recording, do-not-call) | — | `agent_settings` per patient |
| Caregiver notification prefs incl. quiet hours + critical override | — | `notification_settings` per caregiver |
| Family access (Priya "view-only") | — | `family_members` with role |

Derived values to define once server-side: **"today so far"** (the merged event stream of
doses, calls and alerts since 6 AM — used on both `1f` and `2e`), **adherence %**, **"on
track today"**, **next-call time** (dose slot + offset), **severity counts**, **word
frequencies**, **required-fields-remaining** counters.

Client-side, `Call X Now` produces a **`tel:` intent**, never a server-placed call.

---

## 8. Behaviour rules extracted from the annotations

1. **No calls before schedule sign-off.** `1e` / `2d`. Enforce in the scheduler, not just
   the UI.
2. **The first call is an intro call, and it carries no medicines.** `1E.2` / `2D.2`.
3. **Dose calls begin only after the parent agrees on that intro call** — *"All calling
   functionality begins only after this intro call and a final approval from your mom."*
   Sign-off alone is not enough; the gate is two-stage.
4. **All three caregiver consents are mandatory** (parent knows · recording &
   transcription · never gives medical advice). The CTA stays disabled until all three.
5. **Editing medicines requires a doctor-advice attestation** — *"these changes have been
   explicitly advised by our doctor"* — and the attached prescription is optional while
   the attestation is not. `1G.2` / `2F.2`.
6. **Nothing dials from the caregiver's device on its own.** Call buttons open the dialler
   pre-filled; the agent's calls are placed from the service's end.
7. **Every gated CTA is visibly disabled with its reason stated next to it** ("2 left",
   "All three are mandatory", "without the tick the button does nothing").
8. **The intro call is only offered inside the parent's call window** (9 AM – 8 PM);
   times outside it are hidden, not greyed.
9. **Agent calls at dose time + configured offset (default +5 min) only if unconfirmed.**
   A caregiver `Mark taken` cancels that call.
10. **Retry policy is explicit** (2× / 10 min); unanswered calls leave voicemail and
    become a `no answer` alert.
11. **Escalation is timed and ordered**, and the countdown is visible in the alert.
12. **Critical alerts ignore the caregiver's quiet hours**; **do-not-call windows are
    honoured** even when a dose falls inside them. `2k`.
13. **Unreachable ≠ missed** — the status is `unknown`. `2o`.
14. **Flag with the rule, quote the parent, never diagnose.** The literal rule string is
    rendered, never a category label.
15. **No score without a traceable sentence.** Severity chips only.
16. **Recordings default to 90-day retention, with export and delete-everything.**
17. **Nothing is saved until the schedule is approved.** `2o` error state.

---

## 9. Open questions the wireframes raise

- **The third intro-call option — "I'll tell her myself first" — is tagged `3rd option?`.**
  Unresolved. If kept, it needs its own state (waiting on the caregiver, no call
  scheduled, nothing running) and a way back in.
- **Every consent string is `copy TBC`**, as is `1a`'s login copy. Legal/clinical review
  owns them; wire the flow against string IDs, not literals.
- **What happens if Mom says no on the intro call**, or does not answer it? No screen.
- `1b`'s header still reads `1/3` though onboarding is now four steps.
- `1f`'s "Today so far" rows are not in chronological order in the frame.
- `2j` still lives at `/wellbeing`; `2e`'s last-check-in card still shows the old five-dot
  `calm` meter.
- Sub-ID labels are inconsistent with their anchors (`#1e2` displays "1E.2", `#1e3`
  displays "1E.2 sheet"). Pick one scheme before these get cited widely.

---

## 10. Known gaps vs the TRD

**In the wireframes, absent from the TRD:**
- Prescription OCR pipeline and the confidence/`unclear` model
- The consent step: caregiver consents, the intro call, and its gate on the scheduler
- Schedule-change attestation and change log
- Alerts as a first-class feed with read/resolved state
- Messages (parent voice notes, family chat)
- Multi-parent console (`2m`), family view-only access, billing/pricing
- Word-frequency counting over verbatim observations

**In the TRD, absent from the wireframes:**
- **Inbound calls.** The hero path — parent rings in, agent already knows everything — has
  no screen.
- **Intake records and the 12-field completeness meter.** Priority and rule string are
  shown; completeness is not.
- **The `/h/{token}` handoff view itself**, and mobile no longer even links to it.
- **Resume-after-drop** — a resumed session has no representation in the call log.
- **Safety scorer results** (`safety_pass`, findings) — no UI anywhere.
- **Pricing / UPI checkout** (FR-28, FR-29) — linked from `2a` marketing nav only.

**Unresolved directions:** Home `1f` vs `1n` vs `1o` (`2l` argues the quiet version should
be the *good-day* layout of `2e`); Alerts `1h` vs `1p`; intake `1c`+`1d` vs `1q`; desktop
nav `2e` vs `2n` (sidebar recommended — it scales to `2m`).

---

## 11. Build order suggestion

1. **Design system first** — tokens, the components in §2.3, the step-card and disabled
   states, dots, the four states in §6.
2. **Auth `1a` / `2a`** — a four-step state machine with two OTP round-trips and resend
   timers. Bigger than it looks; build it before the profile form.
3. **Onboarding `1b`→`1e` / `2b`→`2d`** with real required-field gating.
4. **Consent + intro call `1E.2`/`1E.2 sheet` / `2D.2`** — and the scheduler gate behind
   it. Nothing may dial before this is correct.
5. **Home + Calendar** (`1f`,`1g` / `2e`,`2f`) — including the shared "today so far"
   stream.
6. **Medicine editor `1G.2` / `2F.2`** — change diff + attestation.
7. **Alerts + detail** (`1h`,`1i` / `2g`) — `alerts` table, priority rule string,
   escalation clock, `tel:` intents.
8. **Calls** (`1j` / `2h`) — transcripts, audio, the "what this call produced" rollup.
9. **What she said** (`1s` / `2j`) — reads `observations` directly; the differentiator.
10. **Settings** (`1m` / `2k`) — unlocks every default the earlier screens hardcode.

When a screen needs something the wireframes do not show, extend using the rules in §2 and
§8 and add the new frame ID here.

---

## 12. Revision history

**Rev 3 — current files.** Consent became a real product surface, the gate moved, and the
product name settled as **Kinvox** across every frame and URL on 30 Aug
(MediWatch → Sahay → Kinvox):

- **Auth rebuilt.** Google/Apple sign-in removed. `1a` / `2a` are now four numbered,
  progressively-unlocking steps: phone → phone OTP → email → email OTP. Language
  selection left login and became "Language the agent should speak" on the profile
  (Hindi default, + Punjabi and "+ more").
- **New step 4 · Consent** — `1E.2` (mobile), `1E.2 sheet` (its time picker), `2D.2`
  (desktop). An **intro call** is placed before anything else, carries no medicines, and
  **dose calls begin only if the parent agrees on it**. Three mandatory caregiver
  consents, all copy `TBC`. A third scheduling option, "I'll tell her myself first", is
  explicitly marked as an open question.
- **The parent-consent toggle left the profile** (`1b` / `2b`) for that step.
- **New medicine editor** — `1G.2` / `2F.2`, reached from the Calendar footer's
  `Edit these medicines` / `Upload new prescription`. Shows pending `edited` / `stopped`
  row states, a plain-language "What changes for Mom" diff, an optional new prescription,
  and a **mandatory doctor-advice attestation** before `Save and Continue`.
- **Home reworked** — last check-in promoted to an attention card with its quote, and a
  new **"Today so far · since 6 AM"** event stream (doses, calls, alerts in one block)
  replacing the old summary card, on both `1f` and `2e`.
- **Alert actions became dialler intents** — `Call Mom Now` / `Call Doctor Now` /
  `Escalate to Priya` each show the number or person they will dial; *nothing dials on its
  own*. `Copy handoff link` was dropped from `1i` and `2g`.
- **CTAs renamed to their destination** — `Upload Prescription`, `Approve Schedule`,
  `Continue to Consent`, `Continue on the app`, `Save and Continue` — and every gated one
  is visibly disabled with its blocking reason beside it.
- New frames use **`kinvox.app`**.

**Rev 2.** Scope narrowed, safety posture pushed into the UI: the whole pharmacy domain
(`1k`, `1l`, `1r`, `2i`, plus stock/refill/prices) and all sentiment scoring were removed;
mobile went 5 tabs → 4; `1s`/`2j` became "What she said" (verbatim + `red`/`watch`/`none`);
the `P1` badge with its literal rule string, the "Told to" card, `Copy handoff link` and
"What this call produced" were added.
