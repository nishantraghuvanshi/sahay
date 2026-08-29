# LANE C — APP & HANDOFF
### Owns: caregiver app · care record · dose history · observations · escalation feed · onboarding + consent gate · handoff view

> **Lowest coupling in the build.** Lane C builds against **mock JSON from hour one**
> and must never be blocked waiting for Lane B. The frozen tool contract doubles as
> the mock spec. Swapping the base URL at integration is a five-minute change;
> waiting on a real endpoint costs six hours.

> **The screens are already drawn.** [`docs/WIREFRAMES.md`](../WIREFRAMES.md) specs every
> screen, component and behaviour rule; the frames themselves are in [`wireframe/`](../../wireframe/).
> Cite frame IDs (`1f`, `2D.2`) in commits and PRs. **Do not invent layout** — and do not
> build anything the wireframes cut: no pharmacy ordering, no refills or stock counts, no
> mood scores or sentiment percentages.

| | |
|---|---|
| **Owner** | _______________ |
| **Depends on** | Tool contract only |
| **Blocks** | Nothing |
| **Done when** | Caregiver sees dose history, observations, escalations **with rule text rendered** · **no call can be placed until sign-off + intro-call consent** · handoff link opens clean on a second phone · live URL deployed |

---

# MVP — "the record is visible"
### T+1 → T+5.5 (19:30 → 00:00) · Checkpoint: T+3h Emergent viability

## Scaffold

- [ ] Emergent project created, credits requested (300 standard / 600 on request)
- [ ] 🚩 **T+3h CHECKPOINT — is the generated code usable?**
      If not, stop and hand-build a minimal read-only app. Do not spend the night
      fighting the generator
- [ ] Note which database Emergent provisions (likely MongoDB) — tell Lane B immediately.
      **Do not fight the generator** on storage choice
- [ ] Routing skeleton for every screen, even if empty — including the two new routes:
      `/setup/consent` (`2D.2`) and `/medicines/edit` (`2F.2`)
- [ ] Brand string is **Kinvox**, domain `kinvox.app`. Dead names — "MediWatch",
      "Sahay", "Voxikin" — survive in older commits and screenshots. Ship none of them.
      ⚠️ **Voxikin is the founder's company**: `[V]` rule 04 keeps it off screen entirely

## Design system first (`WIREFRAMES §2`)

> Every screen is composed from ~20 primitives. Build them once and the rest is assembly.

- [ ] Tokens: ink `#1a1a1a`, card `#fafaf8`, border `#d8d8d4`, dividers, text tiers.
      **One accent — black.** Severity never depends on colour alone
- [ ] Card · **primary card** (1.5px ink border) · **attention card** (3px left rule)
- [ ] `btn` / `ob` / `chip` / `tag` (filled vs outlined) / `lbl` / `in` / `dot`
- [ ] 🔑 **Status dots — three marks only**: filled = done/confirmed/ticked ·
      outlined = missed/negative/needs action · grey = upcoming/locked. Same three carry
      dose status, delivery state, step progress, radio and checkbox
- [ ] **Disabled state** (`opacity .4–.45`) as a real, reusable state — every gated CTA
      in onboarding uses it
- [ ] **Step card** (numbered tag + trailing dot, complete / active / locked) — `§2.5`
- [ ] **Consent row** (dot-as-checkbox + sentence + "N left" counter)
- [ ] Bottom sheet (mobile), split pane + data table (desktop)

## Mock data layer

- [ ] `scripts/mock-api.json` derived **directly from the tool contract** response shapes
- [ ] Single config constant for the API base URL — one line to swap at integration
- [ ] Mock covers: a patient with 3 meds, 5 dose events (one missed), 2 observations,
      1 open intake record with a P1 and a rule string, 1 escalation
- [ ] Mock also covers the new UI state: three caregiver consents, a scheduled **intro
      call** not yet placed, and a schedule-change batch with its attestation

## Care record view (`FR-23`) · frames `2e` card · `1o` tile

- [ ] Patient identity, honorific, age
- [ ] Conditions
- [ ] Allergies
- [ ] Doctor name and phone
- [ ] Medicines — name, dose, slots, with/without food, **priority flag visible**
      ("5 medicines · 1 priority")
- [ ] Meal times
- [ ] Matches the database exactly — a judge may cross-check

## Dose history (`FR-24`) · frames `1g` `2f` `2e`

- [ ] One row per slot per day
- [ ] Status colour-coded: `confirmed` · `deferred` · `missed` · `no_answer`
- [ ] **Provenance shown** — the confirmation time and who confirmed it
      (`7:41 · by Mom`, `on call`)
- [ ] Reconciles with `dose_events` — no derived or smoothed numbers
- [ ] Reason text shown where captured ("strip not found")
- [ ] `unknown` renders as its own status, never as `missed` (`2o` degraded state)

---

# CORE — "the rule is on screen"
### T+5.5 → T+11.5 (00:00 → 06:00) · Gate: T+11.5h, handoff opens on a second phone

## Observations timeline (`FR-25`) · frames `1s` "What Mom said" · `2j`

- [ ] **Verbatim text.** Never paraphrased, never summarised
- [ ] Timestamped
- [ ] Severity chip — `none` / `watch` / `red`
- [ ] Most recent first
- [ ] Provenance per line — the call number, and whether it escalated
- [ ] Filter by severity with counts (`All 14` · `Red 1` · `Watch 4`)
- [ ] Reconciles with the `observations` table
- [ ] 🔑 **No score anywhere.** No mood percentage, no sentiment bar, no wellbeing index —
      *"a number nobody can trace back to a sentence is not evidence"*

## Escalation feed (`FR-26`, `PR-3`) · frames `1i` `2g`

> This is not polish. Rendering the rule string is what converts a subjective-looking
> judgment into an auditable one, and it is the concrete evidence for the rubric's
> *"governing business rules"* clause. It is also the answer when a judge asks
> *"how do you know it's a P1?"*

- [ ] Priority level
- [ ] 🔑 **The literal rule text rendered** — `rule: chest complaint with age over 40`,
      not just `P1`
- [ ] The disclaimer line beside it — *"Triggered on the words she used. No
      interpretation, no diagnosis."*
- [ ] Timestamp
- [ ] Delivery status and channel — the **"Told to"** block: who has been told, when it
      was delivered (`1:37 PM ✓`), and who is still pending (`Priya · in 9 min`)
- [ ] Link through to the intake record
- [ ] Actions carry the identity they will dial: `Call Mom Now +91 …` ·
      `Call Doctor Now Dr. Mehta` · `Escalate to Priya sister` · `Mark resolved`
- [ ] 🔑 **The app never dials.** Those buttons open the phone dialler pre-filled
      (`tel:` intent) — nothing places a call from the caregiver's device

## Onboarding — now **four** steps (`FR-1`–`FR-5`, `J1`) · frames `1a`–`1E.2` / `2a`–`2D.2`

### Step 0 · Auth (`1a` / `2a`)

- [ ] Four progressively-unlocking steps: **phone → phone OTP → email → email OTP**
- [ ] **No social login** — Google and Apple were removed. Do not add them back
- [ ] Each step card shows its state (complete / active / locked); a locked step cannot
      be filled ahead of turn
- [ ] Resend timer on each OTP (`resend in 0:24`)
- [ ] Both `phone_verified_at` and `email_verified_at` persisted

### Step 1 · Parent (`1b` / `2b`)

- [ ] Add parent — name, honorific, phone in **E.164**, age, relation, address
- [ ] **Language the agent should speak** — Hindi default, English, Marathi, Punjabi,
      + more. (Language moved here from the login screen)
- [ ] Clinical context — conditions, allergies, doctor name and number
- [ ] Free-text "anything to keep in mind" — it shapes what the agent says
- [ ] Call window (9 AM – 8 PM) and check-in toggle
- [ ] Escalation contacts, explicitly **optional** and skippable
- [ ] 🔑 **Required-field gating**: CTA disabled with the reason stated beside it —
      "Name, age, relation, phone, language required · 2 left". Escalation contacts do
      not count toward it
- [ ] Button says its destination: **`Upload Prescription`**, not "Next"

### Steps 2–3 · Prescription and schedule (`1c`–`1e` / `2c`–`2d`)

- [ ] Add medicines — name, dose, times, with/without food, end date
- [ ] **At most one medicine marked priority** per patient
- [ ] Meal times (breakfast / lunch / dinner) so slots can be placed sensibly
- [ ] Unclear OCR rows flagged as data, not guessed silently
- [ ] 🔑 **Explicit schedule sign-off gate.** Attempting to schedule without sign-off
      is **refused**, not warned (`FR-4`)
- [ ] CTAs: **`Approve Schedule`** then **`Continue to Consent`**

### Step 4 · Consent + intro call (`1E.2`, `1E.2 sheet` / `2D.2`) — **new**

> The parent-consent toggle used to sit in the profile form. It is now its own step, and
> it is the real gate on the whole product.

- [ ] Route `/setup/consent`; stepper shows **4 · Consent**; header reads
      "nothing has called Mom yet" until the intro call is scheduled
- [ ] Explains the **intro call**: one call, no medicines, says who we are and asks
      whether she is happy to be called
- [ ] Three timing options: **Call Mom now** · **Schedule for later** (bottom sheet on
      mobile, inline chips on desktop) · *"I'll tell her myself first"*
      — ⚠️ this third option is tagged `3rd option?` in the wireframe. **Confirm with
      design before building it**; if kept it needs its own idle state
- [ ] Time picker offers **only slots inside her call window** — outside times hidden,
      not greyed
- [ ] Three **mandatory** consents with a "N left" counter: parent knows · calls recorded
      and transcribed · Kinvox never gives medical advice (`SR-5`)
- [ ] `Continue on the app` stays disabled until all three are ticked
- [ ] "What happens next" ladder: we call Mom → she agrees on that call → dose calls
      begin next morning
- [ ] Note rendered: *"We call Mom from our end — nothing dials from your phone."*
- [ ] 🔑 **The two-stage gate, enforced server-side with Lane B**: schedule sign-off is
      **not** enough. Dose calls start only after the intro call is placed **and** the
      parent agrees on it. Store the consents with **the version of the copy agreed to**
- [ ] ⚠️ Consent strings are marked `copy TBC` in the wireframe. Wire against string IDs;
      chase final copy before demo — see the freeze check in PROOF
- [ ] Whole flow completes in ≤3 minutes

## Medicine editor (`1G.2` / `2F.2`) — **new**

- [ ] Reached from the Calendar footer: `Edit these medicines` · `Upload new prescription`
      — both land on the same editor, on different segments
- [ ] Edit dose, frequency, times; add a medicine; **stop** a medicine (stopped rows stay
      visible, dimmed, badged)
- [ ] Pending changes counted ("3 changes pending") and shown as a plain-language diff —
      **"What changes for Mom"**: `21:00 → 21:30 Metformin` · `Atorvastatin dropped` ·
      `5 → 4 medicines`
- [ ] Attaching a new prescription is **optional**
- [ ] 🔑 **Doctor-advice attestation is mandatory** — *"I am fully aware of the changes I
      am making … explicitly advised by our doctor"* — `Save and Continue` disabled until
      ticked. Persist the attestation with the change batch and who made it
- [ ] Schedule changes propagate to the scheduler (tell Lane B when a slot moves)

## Home (`1f` / `2e`)

- [ ] Next-dose primary card with `Mark taken` — and marking taken **cancels** the agent
      call for that slot
- [ ] The agent-will-call line states the offset ("Agent will call at 2:05 PM if
      unconfirmed")
- [ ] Last check-in card carries the **verbatim quote**, not a summary
- [ ] 🔑 **"Today so far · since 6 AM"** — one merged, chronologically sorted stream of
      doses, calls and alerts, footed with "3 of 5 doses · 1 call · 1 alert".
      *(The wireframe's own rows are out of order — sort them)*

## Handoff view (`FR-17`, `FR-27`, `TRD §11`)

> The most visually convincing five seconds of the demo video — a second physical
> device opening a link and showing a complete record nobody typed.

- [ ] Route `/h/{token}`, **no login**, token is the auth
- [ ] Read-only. Nothing to configure, nothing to install
- [ ] **One phone screen, no scrolling for the P1 fields**
- [ ] Renders all twelve: identity · **chief complaint verbatim** · onset · responsive ·
      breathing · location · medicines · allergies · conditions · callback number ·
      **priority + rule text**
- [ ] Copy-link action in the caregiver app
- [ ] ⚠️ **Conflict to resolve at T-0**: rev 3 of the wireframes **removed**
      `Copy handoff link` from the alert detail (`1i`, `2g`). `FR-27` still requires it.
      Put it back on the alert detail, or agree another entry point — do not let the
      handoff become unreachable
- [ ] `viewed_at` displayed back to the caregiver
- [ ] Expired or invalid token → clean message, never a stack trace

---

# PROOF — "it holds on a stranger's phone"
### T+11.5 → T+17.5 (06:00 → 12:00) · Gate: feature freeze at 12:00

## Integration

- [ ] Swap the base URL from mock to the real Care API
- [ ] Every screen re-verified against live data
- [ ] Empty states — no doses yet, no observations, no escalations (`2o`)
- [ ] Error states — API unreachable shows a message, never a blank screen
- [ ] **Loading is a skeleton, never a spinner** — layout stable before data lands
- [ ] Degraded state: agent cannot reach the parent → doses read `unknown`, the escalation
      that fired is named, and the caregiver is offered `Call Mom yourself` /
      `Try another number` / `Ask neighbour`
- [ ] OCR failure offers a manual path — `Retake` / `Crop & retry` / **`Type it in`**
- [ ] Missing states to add: **intro call scheduled but not yet placed**, and
      **parent declined on the intro call**. Neither is drawn; both are now reachable

## Gate verification (do this with Lane B present)

- [ ] 🔑 Sign off the schedule but **skip consent** → confirm the scheduler places
      **nothing**
- [ ] 🔑 Tick all three consents but let the intro call fail → confirm dose calls still
      do not start
- [ ] Attempt to POST past the UI (curl the API directly) → **refused**, not warned
- [ ] Capture both refusals for `evidence/` — this is the cheapest hard proof in the build

## Mobile

- [ ] 🔑 **Handoff view tested on a real handset**, not a browser resize (`NFR-8`)
- [ ] Caregiver app usable on a phone
- [ ] Tap targets sized for a thumb — and the 8.5px micro-label is **not** shipped at
      8.5px (10–11px, see `WIREFRAMES §2.2`)
- [ ] `tel:` links actually open the dialler on a real handset, number pre-filled
- [ ] Test on a **second physical device** — this is what happens on camera

## Deploy

- [ ] Live public URL (submission accepts a live URL **or** a video — ship both)
- [ ] Handoff view on the same origin as the app
- [ ] No credentials in client-side code
- [ ] Load the live URL on a phone over mobile data, not office wifi

## Demo readiness

- [ ] Screens legible in a screen recording — font sizes, contrast
- [ ] 🔑 **The record visibly updating during a call** is the shot that carries the
      video for a judge watching with the sound off. Make sure it is obvious
- [ ] Nothing on screen that reveals the manual "fire slot now" trigger
- [ ] No placeholder text, no lorem ipsum, no `TODO` visible anywhere
- [ ] 🚩 **No `copy TBC` on screen.** The consent lines and the login copy are unwritten
      in the wireframe — every one of them must carry real copy before recording
- [ ] No blue handwritten annotation text anywhere — those are builder notes, not UI
- [ ] Wordmark says **Kinvox** — never MediWatch, Sahay or Voxikin, in the app or the video

## Pricing note

- [ ] ⚠️ Pricing page + checkout belong to **Lane D**, not C. The docs contradict
      themselves here (`IDEA_SCOPE` §3 says C · `TRD` §1.2 says D · `TRD` §13 says C).
      Confirm at T-0 so it gets built once, by one person
