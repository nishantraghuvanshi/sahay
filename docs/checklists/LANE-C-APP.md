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

> **Emergent was not used.** The app is hand-built: Vite + React + TS + Tailwind +
> react-router, static output, `/h/{token}` on the same origin. The T+3h generator
> checkpoint below is therefore closed as N/A rather than skipped — no generated code to
> judge, no MongoDB constraint to report to Lane B. Rationale: the two things Next/Emergent
> would have bought us (SSR for the handoff, a server to hold `CARE_API_TOKEN`) are both
> better served by the FastAPI in `api/`, which has to be deployed anyway.

- [~] ~~Emergent project created, credits requested~~ — N/A, hand-built
- [~] ~~T+3h CHECKPOINT — is the generated code usable?~~ — N/A
- [~] ~~Note which database Emergent provisions~~ — N/A
- [x] Routing skeleton for every screen, even if empty — including the two new routes:
      `/setup/consent` (`2D.2`) and `/medicines/edit` (`2F.2`)
- [x] Brand string is **Kinvox**, domain `kinvox.app`. Dead names — "MediWatch",
      "Sahay", "Voxikin" — survive in older commits and screenshots. Ship none of them.
      ⚠️ **Voxikin is the founder's company**: `[V]` rule 04 keeps it off screen entirely

## Design system first (`WIREFRAMES §2`)

> Every screen is composed from ~20 primitives. Build them once and the rest is assembly.

- [x] Tokens: ink `#1a1a1a`, card `#fafaf8`, border `#d8d8d4`, dividers, text tiers.
      **One accent — black.** Severity never depends on colour alone
- [x] Card · **primary card** (1.5px ink border) · **attention card** (3px left rule)
- [x] `btn` / `ob` / `chip` / `tag` (filled vs outlined) / `lbl` / `in` / `dot`
- [x] 🔑 **Status dots — three marks only**: filled = done/confirmed/ticked ·
      outlined = missed/negative/needs action · grey = upcoming/locked. Same three carry
      dose status, delivery state, step progress, radio and checkbox
- [x] **Disabled state** (`opacity .4–.45`) as a real, reusable state — every gated CTA
      in onboarding uses it
- [x] **Step card** (numbered tag + trailing dot, complete / active / locked) — `§2.5`
- [x] **Consent row** (dot-as-checkbox + sentence + "N left" counter)
      ↳ built with real `<input type="checkbox">` + `<label>` rather than a dot, so it is keyboard- and screen-reader-operable
- [x] Bottom sheet (mobile), split pane + data table (desktop)
      ↳ sheet and tables done; the alerts split pane is two routes instead, so mobile and desktop share one code path

## Mock data layer

- [x] `scripts/mock-api.json` derived **directly from the tool contract** response shapes
- [x] Single config constant for the API base URL — one line to swap at integration
      ↳ `app/src/config.ts` → `API_BASE`
- [x] Mock covers: a patient with 3 meds, 5 dose events (one missed), 2 observations,
      ↳ 7 dose events, so all four statuses appear; fixture audited by script against TRD §3.2
      1 open intake record with a P1 and a rule string, 1 escalation
- [ ] Mock also covers the new UI state: three caregiver consents, a scheduled **intro
      call** not yet placed, and a schedule-change batch with its attestation

## Care record view (`FR-23`) · frames `2e` card · `1o` tile

- [x] Patient identity, honorific, age
- [x] Conditions
- [x] Allergies
- [x] Doctor name and phone
- [x] Medicines — name, dose, slots, with/without food, **priority flag visible**
      ("5 medicines · 1 priority")
- [x] Meal times
- [x] Matches the database exactly — a judge may cross-check

## Dose history (`FR-24`) · frames `1g` `2f` `2e`

- [x] One row per slot per day
- [x] Status colour-coded: `confirmed` · `deferred` · `missed` · `no_answer`
      ↳ status is never colour-only — every state prints its word, so it survives a greyscale recording
- [x] **Provenance shown** — the confirmation time and who confirmed it
      (`7:41 · by Mom`, `on call`)
- [x] Reconciles with `dose_events` — no derived or smoothed numbers
- [x] Reason text shown where captured ("strip not found")
- [ ] `unknown` renders as its own status, never as `missed` (`2o` degraded state)

---

# CORE — "the rule is on screen"
### T+5.5 → T+11.5 (00:00 → 06:00) · Gate: T+11.5h, handoff opens on a second phone

## Observations timeline (`FR-25`) · frames `1s` "What Mom said" · `2j`

- [x] **Verbatim text.** Never paraphrased, never summarised
- [x] Timestamped
- [x] Severity chip — `none` / `watch` / `red`
- [x] Most recent first
- [x] Provenance per line — the call number, and whether it escalated
- [x] Filter by severity with counts (`All 14` · `Red 1` · `Watch 4`)
- [x] Reconciles with the `observations` table
- [x] 🔑 **No score anywhere.** No mood percentage, no sentiment bar, no wellbeing index —
      *"a number nobody can trace back to a sentence is not evidence"*

## Escalation feed (`FR-26`, `PR-3`) · frames `1i` `2g`

> This is not polish. Rendering the rule string is what converts a subjective-looking
> judgment into an auditable one, and it is the concrete evidence for the rubric's
> *"governing business rules"* clause. It is also the answer when a judge asks
> *"how do you know it's a P1?"*

- [x] Priority level
- [x] 🔑 **The literal rule text rendered** — `rule: chest complaint with age over 40`,
      not just `P1`
- [x] The disclaimer line beside it — *"Triggered on the words she used. No
      interpretation, no diagnosis."*
- [x] Timestamp
- [x] Delivery status and channel — the **"Told to"** block: who has been told, when it
      was delivered (`1:37 PM ✓`), and who is still pending (`Priya · in 9 min`)
- [x] Link through to the intake record
- [x] Actions carry the identity they will dial: `Call Mom Now +91 …` ·
      ↳ labels carry the name only — you asked for the numbers to come off. No second contact has a stored number (schema gap), so that button disables rather than guessing
      `Call Doctor Now Dr. Mehta` · `Escalate to Priya sister` · `Mark resolved`
- [x] 🔑 **The app never dials.** Those buttons open the phone dialler pre-filled
      (`tel:` intent) — nothing places a call from the caregiver's device

## Onboarding — now **four** steps (`FR-1`–`FR-5`, `J1`) · frames `1a`–`1E.2` / `2a`–`2D.2`

### Step 0 · Auth (`1a` / `2a`) — **real, not mocked**

The four cards live in `app/src/setup/AuthSteps.tsx`; `Login.tsx` is the mobile framing
and the desktop landing page (`2a`) reuses the same component.

- [x] Four progressively-unlocking steps: **phone → phone OTP → email → email OTP**
- [x] **No social login** — Google and Apple were removed. Do not add them back
- [x] Each step card shows its state (complete / active / locked); a locked step cannot
      be filled ahead of turn
- [x] Resend timer on each OTP — driven by the server's `resend_after_s`, not a UI
      constant, so the button cannot re-enable before the server would accept
- [x] Both `phone_verified_at` and `email_verified_at` persisted
      ↳ columns now exist; `SCHEMA-GAPS-LANE-C.md` gap #1 is closed
- [x] 🔑 **The code is checked by the server, never the client.** `isOtp()` is a
      six-digit shape check that decides *when to fire the request* — it verifies
      nothing. `secrets.randbelow` generates, `HMAC-SHA256(code, OTP_PEPPER)` stores,
      `hmac.compare_digest` compares
- [x] A code dies on use, on expiry, and after five wrong tries
- [x] **Sending / wrong code / rate-limited** are all visible states. A wrong code shows
      an error and sets `aria-invalid`; it used to silently do nothing
- [x] `/auth/otp/start` answers identically for any destination — a different response
      for a known number is an account-enumeration oracle
- [x] Email verify requires the phone session **first**. Checking the code first let an
      anonymous caller spend someone else's attempts — five requests killed their code
- [x] Session is an opaque token in an httpOnly cookie. `document.cookie` is empty in the
      browser — verified, not assumed

### Step 0.5 · The guard (`FR-1`)

- [x] `RequireAuth` wraps the `AppShell` block and `/setup/*` in `App.tsx`. Before this,
      typing `/home` walked straight past login
- [x] `/` redirects to `/login` without a session, not to `/home`
- [x] 🔑 **`/h/{token}` stays outside the guard.** The token is the auth and the page
      takes no login (`TRD §11`) — putting it behind the guard would break the one
      screen a stranger has to be able to open
- [x] A deep link survives the detour — `/record` while signed out returns to `/record`
      after signing in, not to home
- [x] `client.ts` sends `credentials: 'include'` and treats 401 as a signed-out signal

### Step 1 · Parent (`1b` / `2b`)

- [x] Add parent — name, honorific, phone in **E.164**, age, relation, address
- [x] **Language the agent should speak** — Hindi default, English, Marathi, Punjabi,
      + more. (Language moved here from the login screen)
- [x] Clinical context — conditions, allergies, doctor name and number
- [x] Free-text "anything to keep in mind" — it shapes what the agent says
- [x] Call window (9 AM – 8 PM) and check-in toggle
- [x] Escalation contacts, explicitly **optional** and skippable
      ↳ collected, but nothing can store them — no escalation_contacts table (raised with Lane B)
- [x] 🔑 **Required-field gating**: CTA disabled with the reason stated beside it —
      "Name, age, relation, phone, language required · 2 left". Escalation contacts do
      not count toward it
- [x] Button says its destination: **`Upload Prescription`**, not "Next"

### Steps 2–3 · Prescription and schedule (`1c`–`1e` / `2c`–`2d`)

- [ ] Add medicines — name, dose, times, with/without food, end date
      ↳ ⛔ everything but **end date** — `medications` has no end_date column, and rendering a field the record cannot hold breaks the "matches the DB" claim. Schema gap raised with Lane B
- [x] **At most one medicine marked priority** per patient
      ↳ enforced by rewriting the whole array on every toggle — no code path can produce two
- [x] Meal times (breakfast / lunch / dinner) so slots can be placed sensibly
- [x] Unclear OCR rows flagged as data, not guessed silently
- [x] 🔑 **Explicit schedule sign-off gate.** Attempting to schedule without sign-off
      ↳ disabled button **and** a route guard — browser Forward or a typed URL cannot reach /setup/consent unsigned. Sign-off also clears itself on any later edit, and rejects rows with no name, dose or time
      is **refused**, not warned (`FR-4`)
- [x] CTAs: **`Approve Schedule`** then **`Continue to Consent`**
      ↳ the OCR-step CTA reads **`Continue`** — you renamed it from Approve Schedule

### Step 4 · Consent + intro call (`1E.2`, `1E.2 sheet` / `2D.2`) — **new**

> The parent-consent toggle used to sit in the profile form. It is now its own step, and
> it is the real gate on the whole product.

- [x] Route `/setup/consent`; stepper shows **4 · Consent**; header reads
      "nothing has called Mom yet" until the intro call is scheduled
- [x] Explains the **intro call**: one call, no medicines, says who we are and asks
      whether she is happy to be called
- [x] Three timing options: **Call Mom now** · **Schedule for later** (bottom sheet on
      ↳ **two** options — you confirmed there is no third; "I'll tell her myself" was removed from wireframe and app
      mobile, inline chips on desktop) · *"I'll tell her myself first"*
      — ⚠️ this third option is tagged `3rd option?` in the wireframe. **Confirm with
      design before building it**; if kept it needs its own idle state
- [x] Time picker offers **only slots inside her call window** — outside times hidden,
      ↳ also hides slots already past today, and says so when none are left
      not greyed
- [x] Three **mandatory** consents with a "N left" counter: parent knows · calls recorded
      and transcribed · Kinvox never gives medical advice (`SR-5`)
- [x] `Continue on the app` stays disabled until all three are ticked
- [x] "What happens next" ladder: we call Mom → she agrees on that call → dose calls
      begin next morning
- [x] Note rendered: *"We call Mom from our end — nothing dials from your phone."*
      ↳ verified: no `tel:` anywhere in the setup flow
- [ ] 🔑 **The two-stage gate, enforced server-side with Lane B**: schedule sign-off is
      ↳ ⛔ UI half done; server half needs the endpoint and `intro_call_status`. Cannot be closed by Lane C alone
      **not** enough. Dose calls start only after the intro call is placed **and** the
      parent agrees on it. Store the consents with **the version of the copy agreed to**
- [ ] ⚠️ Consent strings are marked `copy TBC` in the wireframe. Wire against string IDs;
      ↳ ⛔ copy is isolated in one `CONSENTS` array so final wording is a one-line change. Still `copy TBC` on screen
      chase final copy before demo — see the freeze check in PROOF
- [ ] Whole flow completes in ≤3 minutes
      ↳ ⛔ not yet timed with a stopwatch

## Medicine editor (`1G.2` / `2F.2`) — **new**

- [x] Reached from the Calendar footer: `Edit these medicines` · `Upload new prescription`
      — both land on the same editor, on different segments
- [x] Edit dose, frequency, times; add a medicine; **stop** a medicine (stopped rows stay
      visible, dimmed, badged)
- [x] Pending changes counted ("3 changes pending") and shown as a plain-language diff —
      **"What changes for Mom"**: `21:00 → 21:30 Metformin` · `Atorvastatin dropped` ·
      `5 → 4 medicines`
- [x] Attaching a new prescription is **optional**
- [x] 🔑 **Doctor-advice attestation is mandatory** — *"I am fully aware of the changes I
      ↳ string is byte-identical to the wireframe and kept as a named constant so it can be persisted as text. Any further edit clears the tick. Persisting it needs the medication_changes table (raised with Lane B)
      am making … explicitly advised by our doctor"* — `Save and Continue` disabled until
      ticked. Persist the attestation with the change batch and who made it
- [ ] Schedule changes propagate to the scheduler (tell Lane B when a slot moves)
      ↳ ⛔ no mutation endpoint yet — Save is a marked stub naming `POST /app/medications`

## Home (`1f` / `2e`)

- [ ] Next-dose primary card with `Mark taken` — and marking taken **cancels** the agent
      ↳ ⛔ card is built; the button is inert until there is a mutation endpoint
      call for that slot
- [x] The agent-will-call line states the offset ("Agent will call at 2:05 PM if
      unconfirmed")
- [x] Last check-in card carries the **verbatim quote**, not a summary
- [x] 🔑 **"Today so far · since 6 AM"** — one merged, chronologically sorted stream of
      ↳ sorted chronologically, derived on every read and polled at 5s so it changes on camera mid-call
      doses, calls and alerts, footed with "3 of 5 doses · 1 call · 1 alert".
      *(The wireframe's own rows are out of order — sort them)*

## Handoff view (`FR-17`, `FR-27`, `TRD §11`)

> The most visually convincing five seconds of the demo video — a second physical
> device opening a link and showing a complete record nobody typed.

- [x] Route `/h/{token}`, **no login**, token is the auth
- [x] Read-only. Nothing to configure, nothing to install
      ↳ no app navigation at all — verified: zero Links, one `tel:` href
- [x] **One phone screen, no scrolling for the P1 fields**
      ↳ budgeted element by element: 459px worst case vs ~660px usable on 390×844. Still needs the real-handset check below
- [x] Renders all twelve: identity · **chief complaint verbatim** · onset · responsive ·
      ↳ a field never captured prints "not captured", never blank
      breathing · location · medicines · allergies · conditions · callback number ·
      **priority + rule text**
- [x] Copy-link action in the caregiver app
      ↳ on the intake-record card in the alert detail
- [x] ⚠️ **Conflict to resolve at T-0**: rev 3 of the wireframes **removed**
      ↳ RESOLVED — the three dial CTAs stay as redrawn; copy-link moved onto the intake card, so FR-27 holds and the handoff stays reachable
      `Copy handoff link` from the alert detail (`1i`, `2g`). `FR-27` still requires it.
      Put it back on the alert detail, or agree another entry point — do not let the
      handoff become unreachable
- [x] `viewed_at` displayed back to the caregiver
      ↳ "Opened <time>" / "Not opened yet"
- [x] Expired or invalid token → clean message, never a stack trace
      ↳ expired and invalid are different screens with different copy

---

# PROOF — "it holds on a stranger's phone"
### T+11.5 → T+17.5 (06:00 → 12:00) · Gate: feature freeze at 12:00

## Integration

- [ ] Swap the base URL from mock to the real Care API
- [ ] Every screen re-verified against live data
- [x] Empty states — no doses yet, no observations, no escalations (`2o`)
      ↳ `?empty=1` drives them; filtered-empty is visibly distinct from genuinely-empty
- [x] Error states — API unreachable shows a message, never a blank screen
      ↳ `?fail=<key>` forces any single query to fail; `{ok:false}` is thrown, never rendered as data
- [x] **Loading is a skeleton, never a spinner** — layout stable before data lands
- [ ] Degraded state: agent cannot reach the parent → doses read `unknown`, the escalation
      ↳ ⛔ not built — `unknown` is not a value in the DoseStatus union (TRD §3 has four). Needs a schema decision first
      that fired is named, and the caregiver is offered `Call Mom yourself` /
      `Try another number` / `Ask neighbour`
- [ ] OCR failure offers a manual path — `Retake` / `Crop & retry` / **`Type it in`**
      ↳ ⛔ not built — OCR cannot fail in the mock; needs the real endpoint
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

---

## Lane C status — end of the build session

**Screens live** (all against mock, one constant from live data):
`/login` · `/setup/parent` · `/setup/prescription` · `/setup/analysing` · `/setup/schedule` ·
`/setup/consent` · `/home` · `/calendar` · `/medicines/edit` · `/alerts` · `/alerts/:id` ·
`/calls` · `/calls/:id` · `/record` · `/doses` · `/observations` · `/h/:token`

Still placeholders: `/settings`, 404.

**Blocked on Lane B, not on us** — all six written up with DDL in
[`docs/SCHEMA-GAPS-LANE-C.md`](../SCHEMA-GAPS-LANE-C.md):
verification columns · intro-call + consent columns · `medication_changes` audit table ·
`medications.end_date` · `escalation_contacts` · `stock_count` round-trip.
Plus the one thing Lane C needs back: **caregiver-scoped read endpoints**, because the
browser cannot hold `CARE_API_TOKEN` (`NFR-7`). Response shapes are already pinned in
`scripts/mock-api.json`.

**Inert until an endpoint exists** (the onboarding write now lands — `POST /app/onboarding`): `Mark taken`, `Save and Continue`, and the server half
of the two-stage call gate. Each is a marked stub naming the endpoint it needs — none of
them fakes a success.

**Verify any claim above** with `cd app && npm run dev`, then `?fail=<key>` for error
states and `?empty=1` for the day-one experience.
