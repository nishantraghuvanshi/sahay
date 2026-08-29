# Wireframe Specification

Reference for anyone building UI, API responses, or agent behaviour that surfaces in the
caregiver-facing product. It describes **what the wireframes actually say** — screen by
screen, component by component — plus the conventions needed to build new screens that
look and behave like they belong.

Source files (design-canvas HTML, open in a browser):

| File | Frames | Covers |
|---|---|---|
| [`wireframe/Medicine Care App Wireframes.dc.html`](../wireframe/Medicine%20Care%20App%20Wireframes.dc.html) | `1a`–`1s` (15) | Mobile, 320×660 phone frames |
| [`wireframe/Medicine Care App Wireframes — Web.dc.html`](../wireframe/Medicine%20Care%20App%20Wireframes%20—%20Web.dc.html) | `2a`–`2o` (14) | Desktop, 1160×730 browser frames (~1440 viewport) |

Frame IDs are anchors: `…dc.html#1f` jumps to the Home screen. **Cite frame IDs in
tickets, PRs and code comments** — they are the shared vocabulary. Frame IDs are stable
across revisions; deleted frames leave gaps in the sequence rather than renumbering
(`1k`, `1l`, `1r`, `2i` are gone — see §11).

---

## 0. Read this first — three caveats

1. **The product name in the wireframes is "MediWatch". The repo is "Sahay".** Treat
   every "MediWatch" as a placeholder wordmark. Nothing else changes.
2. **Scope is deliberately narrow.** The mobile file states it outright: *"Medicines,
   calls and what she said — no ordering, no mood scoring."* Pharmacy quotes, carts,
   checkout, refills and stock counting are **out**. Sentiment percentages, mood charts
   and wellbeing scores are **out**. What replaced them is a verbatim record of what the
   parent said, severity-tagged, always traceable to a call.
3. **Grey-box fidelity.** No brand colour, no illustration, no final copy. Every grey
   block is a real element with a real purpose; the greyness is deliberate so review
   argues about behaviour, not palette. **Blue handwritten text (`.ann`) is a note to
   the builder — it is never UI.** Do not ship it.

The wireframes now line up closely with [`docs/TRD.md`](TRD.md): P1/P2/P3 priority with
its literal rule string, verbatim observations with severity, the timed escalation
chain, and the read-only handoff link all appear in the UI. §9 lists what still does
not.

---

## 1. Product model the wireframes assume

- **One caregiver account, one parent** (mobile). The desktop alt `2m` shows what
  multi-parent looks like when that assumption breaks.
- **The parent installs nothing.** Every screen in both files is the *caregiver's*
  screen. The parent's entire interface is answering a phone call.
- **The agent calls; the caregiver watches and intervenes.** Every primary action is
  either "confirm what happened" (Mark taken) or "step in myself" (Call Mom now).
- **Capture, never interpret.** The app shows what she said and which rule fired. It
  never shows a diagnosis, a mood score, or a percentage that cannot be traced back to
  a sentence.
- **Nothing is called about until the caregiver signs off the schedule** (`1e`, `2d`).
  A hard gate, not a warning — see §8.
- Currency is not used anywhere (no commerce). Timezone IST, languages English / Hindi /
  Marathi. Example parent "Mom · Sushila Devi · 71 · Pune", caregiver "Rohit",
  escalation contact "Priya (sister)", doctor "Dr. Mehta", neighbour "Mrs Rao".

---

## 2. Design system

### 2.1 Tokens

| Token | Value | Used for |
|---|---|---|
| Canvas | `#f0eee9` | Page background behind frames (canvas only, not in-app) |
| Ink | `#1a1a1a` | Text, borders on emphasis, filled buttons, active nav, "taken" dots |
| Surface | `#fff` | App background, inputs, chips |
| Card | `#fafaf8` | Card fill (`.c`) |
| Card border | `#d8d8d4` | Card and input outlines |
| Divider | `#e4e4e0` | Structural rules (header/footer/pane edges) |
| Divider light | `#eeeeea` / `#f0f0ec` | Row separators inside tables and lists |
| Muted fill | `#dedede` | Text-placeholder bars (`.g`), inactive chart bars |
| Text secondary | `#6d6d6d` | Body support text |
| Text tertiary | `#8d8d8d` | Labels, metadata, timestamps |
| Text placeholder | `#9a9a9a` | Empty input text, disabled rows |
| Selected row | `#f6f6f4` | Table row selection, banner strips |
| Quote highlight | `#ededea` | The transcript line that triggered a flag |
| Annotation | `#2a78d6` + Patrick Hand | **Builder notes only — never ship** |

There is exactly **one accent: black.** Severity, selection, "now", and "taken" all
read as ink-on-white with weight and border thickness doing the work. When colour is
introduced later it must not become the only carrier of meaning — the wireframes prove
the layout survives without it.

### 2.2 Scale

Mobile frames are 320×660 with an 11px body; desktop frames are 1160×730 with an 11px
body. Treat these as **proportions, not literal pixel values**. Recommended mapping
when building (interpretation, not stated in the file):

- Mobile: frame → 390pt device, i.e. ×1.22. Body 11 → 14, screen title 12.5 → 15,
  hero number 20 → 24, micro-label 8.5 → 10–11.
- Desktop: frame 1160 → 1440 content width, i.e. ×1.24. Body 11 → 14, `h1` 15 → 19.
- Never render the 8.5px `.lbl` at 8.5px in production. It is a caps micro-label;
  10–11px with `letter-spacing: .09em` is the intent.

Radii: 6px inputs · 7px buttons/nav · 8px cards/tables · 10px desktop frame ·
99px chips, avatars, toggles, dots. Gaps: 6px within a row group, 8–9px between rows,
11–12px between cards, 16–18px page padding.

### 2.3 Component inventory

Class names in the source map to components you should build once:

| Class | Component | Notes |
|---|---|---|
| `.ph` / `.dt` | Device frame | Mockup chrome only; not a component |
| `.sb` / `.brow` | Status bar / browser chrome | Mockup chrome only |
| `.tp` / `.hd` | Screen header | Mobile: back · title · trailing action. Desktop: 48px, title + inline actions + search |
| `.tb` | Tab bar | Mobile, **4 tabs**, `.on` = active |
| `.sd` | Sidebar | Desktop, 186px, logo · parent switcher · nav · footer widget |
| `.nv` | Nav item | Icon + label + optional `.cnt` count badge; `.on` = active |
| `.c` | Card | Default surface for every grouped block |
| `.c` + `border:1.5px solid ink` | **Primary card** | "The one thing on this screen" — next dose, critical alert |
| `.c` + `border-left:3px solid ink` | **Attention card** | Secondary emphasis — needs review, cited rule, conflict, degraded state |
| `.r` / `.sp` / `.vsp` | Row / spacer-right / spacer-down | Layout primitives |
| `.btn` | Primary button | Filled ink. One per screen region. `opacity:.45` = disabled |
| `.ob` | Secondary button | Outlined ink |
| `.chip` | Chip | Filter, toggle, inline action, tag input. `.on` = selected/filled |
| `.tag` / `.tag.o` | Badge | Filled = severity/state (`critical`, `red`, `P1`, `missed`). Outlined = category (`watch`, `agent`, `no answer`) |
| `.lbl` | Micro-label | 8.5px caps, tertiary. Section and column headers; also the `none` severity |
| `.in` | Input | Also used for read-only display fields |
| `.g` | Placeholder bar | Marketing copy, skeletons, progress meters |
| `.dot` | Status dot | See §2.4 |
| `.im` | Image/media placeholder | Hatched fill |
| `.av` | Avatar | 18/20/26/28/34/52px |
| `.hr` | Divider | |
| `.tbl` / `.th` / `.tr` / `.tr.sel` | Data table | Desktop only |
| `.li` / `.li.sel` | List item | Desktop split-pane list |
| `.pane` / `.pane-b` | List pane / detail pane | Desktop master–detail |
| Toggle | 32×18 pill, 14px knob | Inline, no dedicated class — build one |

### 2.4 Status dots

| Mark | Meaning |
|---|---|
| `.dot.k` filled ink | Taken / done / confirmed / delivered |
| `.dot.x` outlined ink | Missed / negative / unchecked / needs action |
| `.dot` grey | Upcoming / not yet / pending |

The same three dots carry dose status in Home, Calendar, tables, delivery state in
"Told to", and per-person progress in the multi-parent console. Do not invent a fourth.

> One leftover: `2e`'s "Last check-in" card still renders a five-dot row labelled
> `calm`. That is the old sentiment meter; every other instance was removed with mood
> scoring. Treat it as residue — either drop it or replace it with the call's
> highest observation severity.

### 2.5 Copy rules visible in the wireframes

- **Verbatim quotes over summaries.** Alerts and the record lead with what the parent
  actually said — `"Chest feels tight when I walk."` — never a paraphrase. Matches
  TRD §5 `log_observation` (verbatim, never paraphrased).
- **Cite the rule, not the diagnosis.** `1i` / `2g` show a `P1` badge above the literal
  string `rule: chest complaint with age over 40`, then *"Triggered on the words she
  used. No interpretation, no diagnosis."*
- **No score without a sentence behind it.** `1s` / `2j`: *"Her words, timestamped, with
  a severity chip — no mood score, no percentage. A number nobody can trace back to a
  sentence is not evidence."*
- **Consequences, not settings language.** `2b` shows a live call-script preview beside
  the profile form, plus a "Won't ever" list (no medical advice, no penicillin mention,
  no calls after 8 PM).
- **Every error offers a manual path** (`2o`) — "Type it in" always exists.
- Second person, present tense, no exclamation marks. Timestamps are human
  ("6 min ago", "Yesterday", "7:41").

---

## 3. Information architecture

### 3.1 Mobile — 4 tabs

```
Home · Calendar · Alerts · Calls
```

Settings lives behind the ⚙ in the Home header. "What Mom said" (`1s`) is reached from
Home / Alerts / a call, not from the tab bar.

### 3.2 Desktop — sidebar

```
Dashboard · Calendar · Alerts(3) · Calls(2) · Prescriptions · What she said
─────
Settings
```

Sidebar top: logo, then a parent switcher card (avatar · "Mom · 71" · today's status ·
▾). Sidebar bottom: a context widget that changes per section — agent next call (`2e`),
calendar filters (`2f`), escalation chain (`2g`), next scheduled calls (`2h`), weekly
digest (`2j`) — then the caregiver's own row.

### 3.3 Routes (from the browser chrome in the web frames)

| Route | Frame |
|---|---|
| `/` (marketing + login) | `2a` |
| `/setup/parent` · `/setup/prescription` · `/setup/schedule` | `2b` · `2c` · `2d` |
| `/home` | `2e`, alts `2l` `2n` |
| `/calendar` | `2f` |
| `/alerts` · `/alerts/{id}` | `2g` |
| `/calls` | `2h` |
| `/wellbeing` (renders "What she said") | `2j` |
| `/settings/{section}` | `2k` |
| `/console` (multi-parent alt) | `2m` |

`/wellbeing` is a stale path for a screen now called "What she said" — rename to
`/said` or `/record` when building, and keep a redirect if any link already exists.

### 3.4 Mobile → desktop mapping

| Mobile | Desktop | Transformation |
|---|---|---|
| `1a` login | `2a` | Auth column is identical; desktop wraps it in a marketing hero |
| `1b` profile | `2b` | One column → two columns + live script preview |
| `1c` upload + `1d` OCR | `2c` | Two screens → one, side by side |
| `1e` approve | `2d` | Stacked cards → editable spreadsheet with bulk edit |
| `1f` home | `2e` | Stack → day table + persistent attention rail |
| `1g` calendar | `2f` | Day timeline → week grid, drag to reschedule |
| `1h` list + `1i` detail | `2g` | Push navigation → master–detail split pane |
| `1j` calls | `2h` | Log → log + searchable transcript + "what this call produced" |
| `1m` settings | `2k` | Row stack → section rail + two-column page |
| `1s` what she said | `2j` | Card list → table with severity column + repeated-words panel |

**Rule:** desktop never adds a *capability* mobile lacks (except transcript search,
drag-reschedule, bulk edit, and multi-parent). It removes navigation steps.

---

## 4. Mobile screens (`1a`–`1s`)

Each entry: purpose · structure · fields/data · actions · notes.

### `1a` Login / signup
Full-bleed page, no header. Logo → headline "Keep an eye on your parent's meds" → two
placeholder copy bars → **Continue with Google** (primary) → **Continue with Apple** →
"then" divider → email row with `verify mail` tag → phone block (E.164 field + 6-digit
OTP row with `Send`) → language chips (English / हिन्दी / मराठी, English selected) →
legal footer including *consent to place automated voice calls to your parent*.

Phone is **required even on the social path** — escalation and the agent both need a
reachable number. Google is the fast path; verification happens after.

### `1b` Add parent profile — step 1/3
Header: ← · "Who are we caring for?" · `1/3`.

Fields: avatar + Name + `photo` chip · Age · Relation (select) · **Parent's phone —
the agent calls this** · Known conditions (multi-select chips + add) · Allergies &
things to avoid (chips) · free-text "Anything to keep in mind" (the example shows
exactly what it is for: *hard of hearing on the left ear · gets confused after 9 PM ·
won't take tablets without food · call her "Amma"*).

Then two consent blocks:
- **Allow agent check-in calls** (toggle, on) + call window (9 AM–8 PM) + language.
- **"Mom knows about these calls"** (attention card, toggle, on) — *"Tell her before we
  start. She can ask us to stop at any time, on any call."*

Then optional escalation contacts (family / doctor / neighbour chips, explicitly
skippable). CTA: **Next — add prescription**.

Annotation states the design rule: *parent consent is a real gate; family escalation is
not.* Maps to `patients.calls_paused` (TRD §3) and SR-5.

### `1c` Upload prescription — step 2/3
Dashed drop target ("Tap to scan, or drop a file · JPG · PNG · PDF · up to 10 pages") ·
three equal buttons Camera / Gallery / Files · "Added (2)" list with page thumbnail,
filename, upload progress bar, ✕ · tip card · CTA **Analyse prescription**.

Same uploader is reused whenever a new prescription arrives later.

### `1d` OCR analysis progress
Blocking screen, header "Reading prescription… · step 3 / 4". Page preview with
detected boxes overlaid. Four-step checklist with per-step timing:
1. Enhancing & deskewing image — 0.4s ✓
2. Extracting text (OCR) — 1.1s ✓
3. Matching N medicines to drug database — in progress
4. Building dose schedule — pending

Plus "Found so far" chips (with `Atorvas… ?` showing an uncertain match) and a
`2 unclear` badge. ~2s total; stays on screen because the next step depends on results.

### `1e` Approve schedule — step 3/3 — **the gate**
Banner: `check · 2 rows unclear — fix these before you sign off`.
Column legend row: *Dose · frequency · times · food rule · end date*.

One block per medicine: name + form/food rule · dose per dose · ✎ · then a chip row of
frequency · each time · end date. Unclear rows get the attention-card treatment (grey
fill, left rule, `unclear` badge, guessed expansion as subtitle). No stock or refill
fields anywhere.

Footer chips: `+ Add medicine` · `Set all end dates` · `View as calendar`.

Sticky bottom: **an unchecked confirmation** — *"I confirm these 5 medicines, doses and
timings are correct — Nothing is called about until you tick this."* — above a
**disabled** `Approve & start calling` button (rendered at 45% opacity).

> Without the tick the button does nothing and no call is ever placed. This is
> `patients.schedule_signed_off_at` (TRD §3, FR-4). Enforce it server-side too.

### `1f` Home — next dose leads
Header: avatar · "Mom" · "On track today · 3 of 5 taken" · ⚙.

1. **Primary card**: `Next dose · in 22 min` + `2:00 PM` badge → "Metformin 500 mg" →
   "1 tablet · after lunch" → `Mark taken` (primary) + `Call Mom` → `Schedule a call for
   this dose later` → divider → *"Agent will call at 2:05 PM if unconfirmed"* + `edit`.
2. Attention card: `1 alert` · "Missed 6:30 AM Thyronorm" · ›
3. Last check-in call card: time, `transcript` chip, verbatim quote.
4. Today card: "3 of 5 doses confirmed · 2 still to come" + `Open calendar`.

One dose leads; the rest of the day lives in Calendar — no second list to keep in sync.

### `1g` Calendar — day timeline
Header: "August 2026" + `Day ▾`. Week strip (M–S, dot per day showing that day's
outcome, today inverted). Body: time-gutter timeline, one card per dose, multiple
medicines at the same time stack inside one slot. States: `missed` badge + outlined
dot; taken shows the actual confirmation time (7:41); the current slot gets a `now`
chip and a heavier border. Footer legend (taken / missed / upcoming) + `+ dose`.

### `1h` Alerts feed
Header: "Alerts" + `Mark all read`. Two filter rows: **time range** (Day / Month / Year
/ All time) and **category with counts** (All 5 / Critical 1 / Meds 3 / Calls 1).

Alert cards, most severe first, each with badge + relative time + headline + one line of
context + inline actions:

| Type | Badge | Actions |
|---|---|---|
| Critical | filled `critical` + primary card | `Call Mom now` · `Open detail` |
| Missed dose | outlined | `Mark taken` · `Reschedule` |
| No answer | outlined | `Retry now` · `Escalate to Priya` |
| Missed dose (unconfirmed, older) | outlined | `Mark taken` · `Schedule a call` |

Annotation: *date filter above severity — "did anything happen this month?" is the
question people actually arrive with.*

### `1i` Alert detail — verbatim transcript + cited rule
Title + meta line (`Today · 1:35 PM · agent call #214 · 2 min 11 s`) + `critical` badge.

Sections, in order:
1. **Why this was flagged** (attention card) — `P1` badge, the literal rule string
   **`rule: chest complaint with age over 40`**, then *"Triggered on the words she used.
   No interpretation, no diagnosis."*
2. **Transcript excerpt** with speaker badges (`agent` outlined / `mom` filled),
   `Play audio ▶`, "full transcript ›".
3. **Told to** — delivery state per contact: `● You · WhatsApp — 1:37 PM ✓` /
   `○ Priya · in 9 min`.
4. **Context from the record** — "BP meds taken on time · 3 dizziness mentions this
   week".

Actions: `Call Mom now` (primary) → `Copy handoff link` + `Escalate to Priya` →
`Mark resolved`.

Annotation: *the rule string is the point — it turns a judgement call into something
auditable.* This screen is the UI for `intake_records.priority` + `priority_rule`,
`escalations`, and `handoffs` (TRD §3).

### `1j` Calls & messages
Segmented control: **Agent calls** | **Messages**. Each call row: `agent`/`you` badge ·
timestamp · duration or `no answer` · one-line outcome · `Transcript` / `Audio ▶` chips
· `alert` badge if it produced one. Unanswered rows are dimmed and show "Retried twice ·
voicemail left". Below: messages preview (Mom voice note with unread count, Priya text).
Header action: `+ check-in now`.

Annotation: *every call keeps its transcript. What she said is the record — no mood
score sitting on top of it.* No sentiment meters on rows.

### `1m` Settings
Parent card ›. **Voice agent**: check-in calls toggle · times per day (3) · call window ·
voice & language ("Hindi · warm") · retry policy ("2× / 10 min") · record & transcribe.
**Alert rules**: chips — Missed dose, No answer, Unwell, Double dose, Emergency word (all
on), Sleep change (off) — plus "Notify me by: Push + SMS".
**Escalation**: ordered contacts with trigger conditions ("Priya — after 15 min",
"Dr. Mehta — critical only") + add.
**Account**: Prescriptions & documents ›.

### `1s` What Mom said — verbatim, newest first
Header: ← · "What Mom said" · `Month ▾`. Filter chips with counts: `All 14` ·
`Red 1` · `Watch 4`.

One card per thing she said, newest first:
- Severity: filled `red` (attention card) · outlined `watch` · plain `none` micro-label.
- The quote itself, verbatim, in quotation marks, weighted by severity.
- Provenance line: `Call #214 · escalated to you` + `Transcript` chip.

Actions: `Call Mom now` → `Share this week with Priya`.

Annotation: *her words, timestamped, with a severity chip — no mood score, no
percentage. A number nobody can trace back to a sentence is not evidence.* This is the
UI for `observations` (verbatim text + `severity` none/watch/red, TRD §3).

### Alternates — decide before building
| Frame | Direction | Trade-off as written |
|---|---|---|
| `1n` | Home = attention-first: critical card → missed/no-answer card → next dose → today → "Last thing she said" | Calmer on good days ("nothing needs you" empty state), louder on bad ones. Compare with `1f` |
| `1o` | Hub home, no tab bar; six tiles — Alerts, Calendar, Calls, What she said, Care record, Prescriptions — plus "Trigger a check-in call now" | Fewer, bigger targets; costs a tap to reach Calendar/Alerts. Four tabs win on frequency, hub on clarity |
| `1p` | Alerts as one conversational timeline (doses + calls + alerts in one stream) | Better story, worse triage than `1h` |
| `1q` | Camera-first intake, results in a bottom sheet (merges `1c`+`1d`) | Fastest, harder to fix a bad scan |

---

## 5. Desktop screens (`2a`–`2o`)

Shell for every signed-in screen: browser chrome → sidebar (§3.2) → main (48px header
with title, contextual chips, search, and 1–2 actions) → content area, 16×18px padding,
columns with 12–16px gaps.

### `2a` Landing + login
Marketing nav (How it works · Pricing · For families · Log in · Get started) → split
body: left = hero headline, copy bars, `Start free` + `Watch 90-sec demo ▶`, three
value cards (Scan the prescription / Agent calls your parent / **You only hear what
matters — missed dose, no answer, anything she says that needs you**), product
screenshot; right = 376px auth column on tinted ground.

The auth column is mobile `1a` verbatim: **Continue with Google** → Continue with Apple
→ "then" → verified email row → phone + OTP (`required`) → language chips → the
automated-calls consent note. Annotation: *Google first, phone after — same order as
mobile, so the two flows stay identical.*

### `2b` Onboarding 1 — parent profile
Stepper chips in the header (1 · Parent / 2 · Prescription / 3 · Schedule) + "saved just
now" + Exit. Left (flex 1.5): identity row (avatar · Name · Age · Relation) · phone +
city/timezone · conditions and allergies side by side · keep-in-mind textarea · agent
card (toggle + call window + language + voice) · consent attention card (*"She can ask
us to stop on any call, and we stop."*) · escalation card marked `optional` with one
added contact showing its delay and a `+ add family member` chip. Footer: "You can
change all of this later in Settings" · `Back` · `Next — add prescription`.

Right (300px), **web-only and worth building**: **Preview · first call script** — the
actual line the agent would say in the chosen language and tone, plus "Uses" chips
showing which profile fields shaped it (`"Amma"`, `after food`, `Hindi`, `speak
slowly`), and a **"Won't ever"** list (give medical advice · mention penicillin drugs ·
call after 8 PM). It turns profile fields into visible consequences.

### `2c` Onboarding 2 — upload with OCR beside it
Left: large dashed drop zone (also "paste from clipboard") + `Browse files` · three
alternate inputs (Scan with phone (QR) / Import from email / Google Drive) · uploaded
files with size, progress and `read ✓` state · tip.
Right: live OCR panel — "Reading · step 3 of 4" · page preview where **detected dose
lines are boxed and clicking a box jumps to that row** · the four-step checklist ·
"Found so far" chips + `2 unclear` · an allergy cross-check card (*"Penicillin allergy
on file — nothing in this prescription conflicts."*).

### `2d` Onboarding 3 — approve schedule as a spreadsheet
Banner: "2 rows unclear — fix these before you sign off" with `Jump to first` /
`View as calendar`.

Table columns: **Medicine** (name + form) · **Dose** · **Frequency** · **Times** (chips,
`+` to add) · **Food rule** · **End date** · **Alerts** (dot toggle) · ✎. Unclear rows
are selected-styled with an inline-editable cell. Bulk row: `+ Add medicine` ·
`Set all end dates` · `Bulk edit times` · "shift-click to select a range".

Below: **Resulting day** card (every slot as a chip + "6 dose events · 3 agent check-in
calls placed around them") and a **conflict** card (*Thyronorm 06:30 needs an empty
stomach — 30 min before breakfast tea* → `Shift to 06:00` / `Keep`).

Footer row, all inline: the annotation, then the **sign-off checkbox** (attention card,
unchecked: *"I confirm these 5 medicines, doses and timings are correct"*), then
`Save draft`, then a **disabled** `Approve & start calling`. Same gate as `1e`.

### `2e` Dashboard
Header: "Today · Wed 20 Aug" · `On track` · search ("Search meds, calls, alerts…") ·
`Call Mom` · `+ Add medicine` · notifications.

Left column (flex 1.35):
1. Primary next-dose card, wider action set than mobile: `Mark taken` · `Snooze 30 min`
   · `Call Mom` · `Skip with reason` + "agent calls at 2:05 if unconfirmed · edit".
2. "Today's doses" table — Time · Medicine · Rule · Status · Action. Status carries
   provenance: `7:41 · by Mom`, `on call`, `missed`, `upcoming`. Current slot is
   selected with a `now` chip.
3. Adherence, last 14 days — bar per day + `Export CSV`.

Right rail (326px) — "Needs you":
- Critical alert card (verbatim quote + `Call Mom now` / `Open`).
- Attention card combining `missed` and `no answer` with `fix` / `retry` chips.
- Last check-in card: time, `Transcript`, the quote. (Still carries the legacy dot row
  — see §2.4.)
- **What she said this week** (attention card): `1 red` badge, the red quote, "Today
  1:36 PM · 4 more entries", `View all`.
- **Care record**: "5 medicines · 1 priority" + `Open` · allergies line · doctor with a
  `Call` chip.

### `2f` Calendar — week grid
Header: month · ‹ Today › · Day/Week/Month/Agenda · "17–23 Aug · 86% taken" · `+ Add
dose`. Day columns across, time rows down; each cell is a card holding that slot's
medicines with status dots. Future days are dimmed (opacity .55), missed cells get the
left rule + `missed` badge, the current cell gets a heavy border + `now`.

Footer: legend + `Print / share PDF`. **Drag a card to another cell to reschedule that
one dose; shift-drag moves the whole series.** Sidebar carries the filter chips (All
meds / per-medicine / Calls).

### `2g` Alerts — master–detail
Left pane (330px): filter chips with counts (All 6 / Critical 1 / Meds 3 / Calls 1) then
list items; resolved items dimmed at the bottom; selected item styled.

Right pane: title + meta + `critical` badge + `Copy link` + ‹ › paging → action row
(`Call Mom now` · `Escalate to Priya` · `Copy handoff link` · `Mark resolved`) with
**keyboard hints "j / k to move · r to resolve"** → two columns:
- Wide: **Why this was flagged** (attention card, `P1` badge + `rule: chest complaint
  with age over 40` + "Triggered on the words she used. No interpretation, no
  diagnosis") · full transcript with per-line timestamps and the triggering line
  highlighted · audio scrubber (0:44 / 2:11).
- Narrow (250px): **Told to** (You · WhatsApp 1:37p ✓ / Priya · in 9 min) · **Context**
  checklist · **Activity** timeline (agent flagged 1:37p · push+SMS to you 1:37p ·
  Priya notified in 9 min) · "Note for the family" input.

Told to + Activity are the escalation clock made visible — build them against
`escalations` (TRD §3), including `delivery_status`.

### `2h` Calls & messages
Left pane (300px): **transcript search** + filters (Agent / Mine / Messages / Flagged);
rows carry badge, time, duration, one-line outcome, and an `alert` badge where the call
produced one. No sentiment meters.

Right pane: call header (`Check-in call #214 · Today 1:35 PM · 2 min 11 s · Hindi ·
agent "warm"`) + `Call Mom` + `Share with Priya` → **What this call produced** —
outcome chips (`2 doses confirmed` · `1 observation · red` · `1 escalation · P1` ·
`handoff link created`), the rule string and when it was written, and `Open in record`
→ transcript with timecodes, Hindi/English toggle, and the triggering line highlighted
→ right column: **What the call achieved** (per-dose outcomes with dots), **Topics
detected** chips, Messages preview.

"What this call produced" is the single best UI summary of the tool contract: one call
writes dose events, observations, an escalation, and a handoff link.

### `2j` What she said — verbatim, severity-tagged, newest first
Header: "What she said" · date range · `Red + watch only` · `needs attention` ·
`Share with Priya` · `Export PDF for doctor`.

Left (flex 1.5):
1. Primary card: `summary` badge, "from 18 calls this week", **"14 things she said · 1
   red · 4 watch"**, then *"Every line below is what she actually said, timestamped,
   with the call it came from. Nothing is summarised or scored."*
2. Table — **When · Severity · What she said · Call · action**. Severity column is
   `red` / `watch` / `none`; the quote is the wide column; the call number links to the
   call; `Transcript` chip per row.
3. **Words that repeat** — counted from her exact words (`sleep 4×`, `knee 2×`,
   `quiet / alone 3×`, `grandson 5×`, `chest 1×`) with *"tap one to see every line it
   appears in"*.
4. **This week** — Doses confirmed 31 of 36 · Calls answered 16 / 18 · Escalations
   raised 1 · P1.

Right (320px): **Needs a look** — the flagged quotes with their repetition count and
`Transcript`, `Play all` → **Suggested** actions (add a 6 PM chat call · ask Priya to
visit · mention sleep to Dr. Mehta) → `Call Mom now` + `Add daily chat call` +
`Tell Priya`.

### `2k` Settings
Section rail (196px): **Parent** (Profile & conditions · Medicines & schedule ·
Prescriptions) · **Agent** (Calls & voice · Alert rules · Escalation) · **Account**
(Family & access · Notifications · Billing · Privacy & data).

"Calls & voice" page, two columns:
- Calls: enable toggle · calls per day (2/3/4/Custom) · call window (two time inputs) ·
  **offset from a dose (+5 min)** · retry policy (2× / 10 min) · leave voicemail.
  Voice: language + fallback language · tone (Warm/Neutral/Brisk) · speed slider ·
  **"Calls her: Amma"** + `Preview ▶` · record & transcribe with the note *"Mom is told
  on the first call"*. **Do not call** windows (During temple 6–7 AM · Sunday afternoon).
- Alert rules: which events notify (Missed dose · No answer · Unwell · Double dose ·
  Emergency word on; Sleep change, Says she is unwell off) · missed-dose threshold
  (30 min) · channels (Push / SMS / Email / WhatsApp) · **quiet hours for me** ·
  **critical ignores quiet hours**.
  **Escalation chain**, ordered and numbered: 1 Rohit (immediately) · 2 Priya (after 15
  min · view-only access) · 3 Dr. Mehta (critical only · SMS) · 4 Neighbour Mrs Rao (no
  answer 3× · call only). **Data**: keep recordings 90 days · export everything ·
  delete account & data.

Header actions: `Test call to me` · `Save`.

### Alternates
| Frame | Direction | Trade-off as written |
|---|---|---|
| `2l` | "Quiet wall" dashboard — icon-only 64px rail, one sentence centred, two status chips, three actions (`Mark 2 PM taken` · `Listen to 9:12 AM call` · `Read what she said today`), 14-day bar | Dense `2e` wins for daily managers; quiet wins for people who dread opening the app. On a bad day the centre becomes the critical alert |
| `2m` | Multi-parent console — sidebar lists people; one row per person (doses today as dots · next dose · last call · **last said** · needs you · action) + combined alert feed + cross-parent stats + **one handoff per person: "3 read-only links · no login"** | Where a second parent or a paid family-manager tier stops being painful. **Row = person, not medicine** |
| `2n` | Top nav instead of sidebar (Dashboard · Calendar · Alerts · Calls · What she said), three equal columns; cards for next dose, today, critical alert, recent calls, care record, what she said, prescriptions, agent | Frees ~190px, reads like a consumer site; costs the persistent parent switcher and the peripheral alert count. Sidebar scales to `2m`, top nav does not |
| `2o` | **States** — build these | See §6 |

---

## 6. States (`2o`) — required for every screen

| State | Spec |
|---|---|
| **Empty** | Dashed card, icon, "No medicines yet", one line of what happens next, primary CTA `Add prescription`, secondary `Enter manually instead` |
| **Loading** | **Skeleton, never a spinner.** Grey bars in the final layout's shape — "layout is stable before data lands, no jump" |
| **Degraded — agent can't reach parent** | `agent offline` badge + since-time, "4 calls have not connected", plain cause list (phone off / out of network / blocked), then the two consequences: **doses tracked as "unknown", not missed**, and "Priya notified at 6:35 PM". Actions: `Call Mom yourself` · `Try another number` · `Ask neighbour` |
| **Error — OCR failed** | `couldn't read` badge, "We got 2 of 5 lines", blurred preview, the specific cause ("blurry near the dosage column"), three recoveries `Retake photo` / `Crop & retry` / `Type it in`, and the reassurance *"Nothing is saved until you approve the schedule."* |

Two rules generalise: **an unreachable parent produces `unknown`, never `missed`** (do
not let a network failure become an adherence penalty), and **every error offers a
manual path.**

---

## 7. Data the wireframes require

Mapped to [`docs/TRD.md`](TRD.md) §3 where a table already exists.

| UI need | Existing | Gap to add |
|---|---|---|
| Parent identity, conditions, allergies, language, honorific, address, sign-off, pause | `patients` | photo, relation, timezone, "keep in mind" free text, do-not-call windows |
| Medicines, dose, slots, food rule, priority flag | `medications` | end date, per-medicine alerts on/off, unclear/needs-review flag, OCR source ref. (`stock_count` is now unused by the UI) |
| Dose status incl. provenance and confirmation time | `dose_events` (`confirmed`/`deferred`/`missed`/`no_answer`) | `unknown` status (from `2o` degraded), `skipped_with_reason`, actor (parent on call / caregiver in app), snooze |
| Call log, duration, transcript, language, direction | `call_sessions` | audio URL, voicemail flag, retry count, per-call outcome summary ("what this call produced"), topics detected |
| Verbatim quotes with severity `none`/`watch`/`red` | `observations` | word-frequency rollup for "Words that repeat"; link from observation → alert |
| Priority `P1`/`P2`/`P3` + literal rule string | `intake_records.priority`, `priority_rule` | surfaced directly in `1i` / `2g` / `2h` — never render an empty rule |
| Escalation with cited rule, channel, delivery status | `escalations` | scheduled-but-not-yet-sent state ("Priya · in 9 min"), per-contact trigger config and ordering |
| Handoff link, copy action, viewed state | `handoffs` | surfaced as `Copy handoff link` in `1i` / `2g`, "handoff link created" in `2h`, and per-person links in `2m` |
| Alerts feed | — | **`alerts` table**: type (critical / missed_dose / no_answer / double_dose / sleep_change), severity, source (call / scheduler), headline, read + resolved state, actions taken |
| Prescriptions, pages, OCR result, confidence | — | `prescriptions` + `prescription_pages` + extracted rows with confidence, so `unclear` is data, not a guess |
| Agent config (per-day count, window, offset, retries, tone, speed, name, recording, do-not-call) | — | `agent_settings` per patient |
| Caregiver notification prefs incl. quiet hours + critical override | — | `notification_settings` per caregiver |
| Family access (Priya "view-only") | — | `family_members` with role |

Derived values the UI displays, so define them once server-side: **adherence %** over a
window, **"on track today"**, **next-call time** (dose slot + configured offset),
**severity counts** for the filter chips, **word frequencies** over a date range.

---

## 8. Behaviour rules extracted from the annotations

1. **No calls before sign-off.** `1e` / `2d`. Enforce in the scheduler, not just the UI.
2. **Parent consent is a gate; family escalation is optional.** `1b` / `2b`.
3. **The parent can stop the calls on any call, and we stop.** `2b` — needs a runtime
   pause path.
4. **One dose leads on Home; the day lives in Calendar.** No duplicate list to sync.
5. **Agent calls at dose time + configured offset (default +5 min) only if
   unconfirmed.** A caregiver `Mark taken` cancels that call.
6. **Retry policy is explicit** (default 2× / 10 min); unanswered calls leave voicemail
   and become a `no answer` alert.
7. **Escalation is timed and ordered** (you → 15 min → sister → doctor for critical →
   neighbour after 3 no-answers) and the countdown is visible in the alert.
8. **Critical alerts ignore the caregiver's quiet hours.** `2k`.
9. **Do-not-call windows are honoured** even when a dose falls inside them. `2k`.
10. **Unreachable ≠ missed.** `2o` — the status is `unknown`.
11. **Flag with the rule, quote the parent, never diagnose.** `1i` / `2g` — the literal
    rule string is rendered, never a category label.
12. **No score without a traceable sentence.** `1s` / `2j` — severity chips only.
13. **A handoff link is one action away from any critical alert**, and is read-only, no
    login. `1i` / `2g` / `2m`.
14. **Recordings default to 90-day retention, with export and delete-everything.** `2k`.
15. **Nothing is saved until the schedule is approved.** `2o` error state.

---

## 9. Known gaps and open questions

**In the wireframes, absent from the TRD** — decide whether in scope or roadmap:
- Prescription OCR pipeline and the confidence/`unclear` model
- Alerts as a first-class feed with read/resolved state
- Messages (parent voice notes, family chat)
- Multi-parent console (`2m`), family view-only access, billing/pricing
- Word-frequency counting over verbatim observations (`2j`)

**In the TRD, absent from the wireframes** — these need screens before they ship:
- **Inbound calls.** The Calls tab shows only outbound agent calls and caregiver calls.
  The hero path — parent rings in, agent already knows everything — has no screen.
- **Intake records and the 12-field completeness meter.** Priority and the rule string
  are now shown; completeness is not.
- **The `/h/{token}` handoff view itself.** The app can create and copy the link; the
  page the recipient opens is unspecified here.
- **Resume-after-drop** — a resumed session has no representation in the call log.
- **Safety scorer results** (`safety_pass`, findings) — no UI anywhere.
- **Pricing / UPI checkout** (FR-28, FR-29) — linked from `2a` marketing nav only.

**Unresolved within the wireframes:**
- Home direction: `1f` (next dose) vs `1n` (attention-first) vs `1o` (hub). `2l` argues
  the quiet version should be the *good-day* layout of `2e` rather than a separate one.
- Alerts: triage list `1h` vs one timeline `1p`.
- Intake: two-step `1c`+`1d` vs camera-first `1q`.
- Nav on desktop: sidebar `2e` vs top bar `2n` (sidebar recommended — it scales to `2m`).
- Leftovers from the removed scope, to clean up when building: `2m`'s header still reads
  "3 low stock"; `2j` still lives at `/wellbeing`; `2e`'s last-check-in card still shows
  the old five-dot `calm` meter.

---

## 10. Build order suggestion

1. **Design system first** — tokens, the components in §2.3, dots, the four states in
   §6. Everything else is composition.
2. **Onboarding `1a`→`1e` / `2a`→`2d`.** It ends at the sign-off gate, the precondition
   for any call. Ship the gate server-side with it.
3. **Home + Calendar** (`1f`,`1g` / `2e`,`2f`) — reads from dose events; no new domain.
4. **Alerts + detail** (`1h`,`1i` / `2g`) — needs the `alerts` table, the priority rule
   string, the escalation clock, and the handoff link action.
5. **Calls** (`1j` / `2h`) — transcripts, audio, and the "what this call produced"
   rollup.
6. **What she said** (`1s` / `2j`) — reads `observations` directly; cheap once calls
   exist, and it is the product's differentiator.
7. **Settings** (`1m` / `2k`) — unlocks every configurable default the earlier screens
   hardcode.

When a screen needs something the wireframes do not show, extend using the rules in §2
and §8 and add the new frame ID to this doc.

---

## 11. Revision history

**Rev 2 — current files.** Scope narrowed and safety posture pushed into the UI:

- **Removed:** the entire pharmacy domain — `1k` Order, `1l` Checkout, `1r` auto-refill
  cart, `2i` quote comparison + checkout rail — plus every stock count, refill alert,
  "days left" meter and price. Mobile went from **5 tabs to 4** (Order dropped); the
  desktop sidebar dropped **Order meds** and **Wellbeing**.
- **Removed:** all sentiment scoring — the mood chart, "Worried · 72%", per-call
  sentiment series, mood-vs-adherence correlation, and the 5-dot meters on call rows.
- **Replaced:** `1s` and `2j` are no longer "Mood & wellbeing" but **"What (Mom) she
  said"** — verbatim quotes, `red`/`watch`/`none` severity, call provenance, and
  repeated-word counts drawn from her exact words.
- **Added:** the P1/P2/P3 badge with its **literal rule string** in `1i` / `2g` / `2h`;
  the **Told to** delivery card; **Copy handoff link** as a first-class action
  (`1i`, `2g`, `2m`); **What this call produced** in `2h`; a **Care record** card on the
  dashboard.
- **Changed:** `2a` now leads with Google (matching mobile `1a`) instead of phone OTP;
  `2d` moved the sign-off checkbox inline into the footer action row; `1e` / `2d`
  dropped the stock column and now say "fix these before you sign off".
