# LANE C — APP & HANDOFF
### Owns: caregiver app · care record · dose history · observations · escalation feed · onboarding · handoff view

> **Lowest coupling in the build.** Lane C builds against **mock JSON from hour one**
> and must never be blocked waiting for Lane B. The frozen tool contract doubles as
> the mock spec. Swapping the base URL at integration is a five-minute change;
> waiting on a real endpoint costs six hours.

| | |
|---|---|
| **Owner** | _______________ |
| **Depends on** | Tool contract only |
| **Blocks** | Nothing |
| **Done when** | Caregiver sees dose history, observations, escalations **with rule text rendered** · handoff link opens clean on a second phone · live URL deployed |

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
- [ ] Routing skeleton for every screen, even if empty

## Mock data layer

- [ ] `scripts/mock-api.json` derived **directly from the tool contract** response shapes
- [ ] Single config constant for the API base URL — one line to swap at integration
- [ ] Mock covers: a patient with 3 meds, 5 dose events (one missed), 2 observations,
      1 open intake record with a P1 and a rule string, 1 escalation

## Care record view (`FR-23`)

- [ ] Patient identity, honorific, age
- [ ] Conditions
- [ ] Allergies
- [ ] Doctor name and phone
- [ ] Medicines — name, dose, slots, with/without food, **priority flag visible**
- [ ] Meal times
- [ ] Matches the database exactly — a judge may cross-check

## Dose history (`FR-24`)

- [ ] One row per slot per day
- [ ] Status colour-coded: `confirmed` · `deferred` · `missed` · `no_answer`
- [ ] Reconciles with `dose_events` — no derived or smoothed numbers
- [ ] Reason text shown where captured

---

# CORE — "the rule is on screen"
### T+5.5 → T+11.5 (00:00 → 06:00) · Gate: T+11.5h, handoff opens on a second phone

## Observations timeline (`FR-25`)

- [ ] **Verbatim text.** Never paraphrased, never summarised
- [ ] Timestamped
- [ ] Severity chip — `none` / `watch` / `red`
- [ ] Most recent first
- [ ] Reconciles with the `observations` table

## Escalation feed (`FR-26`, `PR-3`)

> This is not polish. Rendering the rule string is what converts a subjective-looking
> judgment into an auditable one, and it is the concrete evidence for the rubric's
> *"governing business rules"* clause. It is also the answer when a judge asks
> *"how do you know it's a P1?"*

- [ ] Priority level
- [ ] 🔑 **The literal rule text rendered** — `rule: chest complaint with age over 40`,
      not just `P1`
- [ ] Timestamp
- [ ] Delivery status and channel
- [ ] Link through to the intake record

## Onboarding (`FR-1`–`FR-5`, `J1`)

- [ ] Caregiver signup — name, phone, relationship
- [ ] Add parent — name, honorific, phone in **E.164**, language, age, address
- [ ] Clinical context — conditions, allergies, doctor name and number
- [ ] Add medicines — name, dose, times, with/without food
- [ ] **At most one medicine marked priority** per patient
- [ ] Meal times (breakfast / lunch / dinner) so slots can be placed sensibly
- [ ] 🔑 **Explicit schedule sign-off gate.** Attempting to schedule without sign-off
      is **refused**, not warned (`FR-4`)
- [ ] Copy telling the caregiver to inform the parent that these calls are coming (`SR-5`)
- [ ] Whole flow completes in ≤3 minutes

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
- [ ] `viewed_at` displayed back to the caregiver
- [ ] Expired or invalid token → clean message, never a stack trace

---

# PROOF — "it holds on a stranger's phone"
### T+11.5 → T+17.5 (06:00 → 12:00) · Gate: feature freeze at 12:00

## Integration

- [ ] Swap the base URL from mock to the real Care API
- [ ] Every screen re-verified against live data
- [ ] Empty states — no doses yet, no observations, no escalations
- [ ] Error states — API unreachable shows a message, never a blank screen

## Mobile

- [ ] 🔑 **Handoff view tested on a real handset**, not a browser resize (`NFR-8`)
- [ ] Caregiver app usable on a phone
- [ ] Tap targets sized for a thumb
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

## Pricing note

- [ ] ⚠️ Pricing page + checkout belong to **Lane D**, not C. The docs contradict
      themselves here (`IDEA_SCOPE` §3 says C · `TRD` §1.2 says D · `TRD` §13 says C).
      Confirm at T-0 so it gets built once, by one person
