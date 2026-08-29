# LANE D — EVIDENCE, REVENUE, SUBMISSION
### Owns: pricing + checkout · unit economics · the 3 cold runs · the video · the viral post · README · GTM brief · selling in the room

> **This is not a consolation role.** Stage demos are **top 3 only**. Everyone else is
> judged from the submission during a **30-minute window across all teams**. The
> recorded video is the judged artifact. A team where all four people code and nobody
> owns the video loses on a technicality.
>
> Two of the six scored surfaces live here.

| | |
|---|---|
| **Owner** | _______________ |
| **Depends on** | Nothing for MVP. A working system for cold runs |
| **Blocks** | Submission |
| **Done when** | ≥1 real payment · 3 cold runs recorded and scored · unit economics with same-day rates · video cut · viral post published with screenshots · submission complete |

---

# MVP — "we can take money"
### T+0 → T+5.5 (18:30 → 00:00)

## V4 — pull the rates at T-0, before they matter

- [ ] ElevenLabs agent ₹/min — screenshot the dashboard, note the time
- [ ] Twilio US→IN voice ₹/min — screenshot the live pricing page
- [ ] LLM cost per call — provider dashboard
- [ ] ⚠️ *"What does a call cost you?"* is the most likely Revenue challenge from a judge.
      Answer with measured numbers and the dashboard open, or say
      **"measured, not modelled"** and show it

## Telephony purchase

- [ ] Buy the Twilio US number (card transaction — D owns purchase, **A owns routing**)
- [ ] Confirm it supports inbound **and** outbound before handing to A
- [ ] Note the monthly + per-minute cost for the economics table

## Pricing page (`FR-28`)

- [ ] Three tiers live on a public URL
  - [ ] Trial — free, 7 days, 1 dose slot/day, inbound line
  - [ ] **Care — ₹499/mo** — up to 2 slots/day, inbound line, caregiver app, escalations
  - [ ] **Care+ — ₹999/mo** — unlimited slots, priority-medicine alerts, handoff links
- [ ] ⚠️ **Resolve the appointment-reminders contradiction.** It is cut in PRD §14 but
      listed in the Care+ tier in §15. Either mark it "coming soon" or delete it —
      on the Revenue track a judge is likely to open this page
- [ ] Benchmark line for context: Carissa ₹1,499/mo · ElderVoice $19/$49 ·
      Zangy $9.99 + per-min · Edesy ₹4–6/min

## Checkout (`FR-29`, `FR-30`)

- [ ] UPI payment link live and tested with a ₹1 transaction to yourself
- [ ] Successful payment writes a `subscriptions` row visible in the app (`FR-30`)
- [ ] Confirmation screen or message the buyer actually receives
- [ ] Landing copy — the parent doesn't install anything, the child pays

---

# CORE — "we have buyers and a script"
### T+5.5 → T+11.5 (00:00 → 06:00)

## Write the three cold-run scripts (`TRD §18.1`)

> **Cold means:** a different person places the call, reading a script they have not
> rehearsed, with **no builder touching a keyboard**. Recorded end to end.

- [ ] **R1** — chest tightness, 20 min onset, responsive, breathing normal, at home
      → expect 12/12 · **P1** *rule: chest complaint with age over 40* · escalation · handoff link
- [ ] **R2** — a **neighbour** calls about a fall; patient responsive, breathing normal, confused
      → expect 12/12 · **P2** *rule: acute onset with red-flag symptom* ·
      field 1 captures the neighbour and the relationship
- [ ] **R3** — same as R1 but **hang up after field 4**, redial after 60s
      → expect resume with **zero questions repeated**, final record 12/12
- [ ] Each script written so a stranger can read it cold
- [ ] Ground truth for all 12 fields written **before** the run, not after

## Scoring sheet (`TRD §18.2`)

One row per run:

- [ ] Fields captured — n/12
- [ ] Fields correct against ground truth — n/12
- [ ] Fields inherited, not asked — **should be 6**
- [ ] Parent turns to complete — target **≤7**
- [ ] Priority assigned vs expected
- [ ] Rule text stored — non-empty, correct rule
- [ ] Escalation sent — y/n, latency
- [ ] Safety verdict — **must be PASS**
- [ ] Builder intervention — **must be none**
- [ ] `S1 = mean(fields correct ÷ 12)` across R1–R3. **Target ≥ 0.85**

## Selling — start at T+12h, not T+20h

- [ ] 🔑 **Line up 5 buyers by T+12h.** The room is full of the ICP: 28–45,
      moved cities for work, parents elsewhere
- [ ] One-line opener that names the moment, not the product:
      *"Do you know if your mother took her tablet this morning?"*
- [ ] Sell to people who are **genuinely** the ICP. Terms clause 09 permits
      **contact checks with your signups** — a favour-payment from a friend who
      isn't the customer is a challenge you lose
- [ ] Post the teaser

---

# PROOF — "the submission stands alone"
### T+11.5 → T+23.5 (06:00 → 18:00)

## Record and score the three runs (T+11.5 → T+17.5)

- [ ] Recruit three people who did not build this
- [ ] Record R1 end to end — screen + audio
- [ ] Record R2 end to end
- [ ] Record R3 end to end, including the hang-up and redial
- [ ] Score all three against ground truth
- [ ] 🚩 **S1 ≥ 0.85** · 🚩 **zero safety FAILs** · 🚩 **zero builder intervention**
- [ ] If a run FAILs on safety, it is **invalid** — re-run it. Never ship a FAIL
- [ ] Store recordings, transcripts, and the filled sheet in `/evidence`

## Unit economics (`TRD §21`)

- [ ] `COGS per call = (ElevenLabs ₹/min × avg_min) + (Twilio ₹/min × avg_min) + LLM tokens`
- [ ] Avg call minutes **measured from R1–R3**, not estimated
- [ ] `Care tier = 2 slots × 30 days = 60 outbound + ~2 inbound = 62 calls/month`
- [ ] `Gross margin = (499 − COGS × 62) ÷ 499`
- [ ] ⚠️ **Do not state a margin that was not measured**

## Close the sale (T+17.5 → T+20.5)

- [ ] 🚩 **≥1 real payment received** — this is Revenue L5
- [ ] Payment confirmation screenshotted
- [ ] Subscription row visible in the app
- [ ] Buyer is contactable and would confirm if asked

## The video — 3 minutes, one unbroken take for the demo section (T+17.5 → T+20.5)

> The handbook's Demo Prep prescribes 30s context / 30s manual workflow / 2min live.
> That structure is written for the **top-3 stage slot**. For the submission video,
> **front-load the working product** — a judge on entry #17 of 30 decides in the first
> twenty seconds.

- [ ] **0–20s** — cold open on the hero moment, no setup. Parent dials. Agent:
      *"Hello Sharma-ji — is this about the chest discomfort you mentioned this morning?"*
- [ ] **20–45s** — now the context. 149M Indians 60+ · 36% have a migrant child ·
      medicines-on-time is the #1 stated worry
- [ ] **45s–2:30** — the full loop, **one take**: outbound dose call → record updates on
      screen → inbound call inherits it → 12 fields fill → priority **with the rule
      string visible** → caregiver notified **by name** → **drop the call, redial, it resumes**
- [ ] **2:30–2:45** — the three cold runs side by side with the accuracy number
- [ ] **2:45–3:00** — the real payment confirmation. **Close on that, not on architecture**
- [ ] 🔑 **Watch it once with the sound off.** The hero moment is audio; the record
      updating, the rule string, and the handoff link opening on a second phone are
      what carry it visually
- [ ] Nothing on screen reveals the manual "fire slot now" trigger
- [ ] 🚩 **Video locked at T+20.5h (15:00)**

## Virality (T+20.5 → T+22.5)

- [ ] Post on LinkedIn / X / Instagram with a real narrative hook
- [ ] Screenshot **post performance** — impressions, likes, reshares, comments
- [ ] Screenshots saved to `/evidence`
- [ ] *(Required in the submission even though Revenue is the primary track)*

## Written deliverables

- [ ] `README.md` — **working build instructions**, required by submission
- [ ] `docs/GTM.md` — go-to-market brief, required by submission
- [ ] Unit-economics table in `/evidence`
- [ ] 🔑 **Borderline-starting-point note**, accurately worded:
      > *Borderline starting point: I am a founder in elder-care voice AI. A prior
      > codebase exists for a related use case; it was not used, opened, or shown.
      > This is a from-zero build. No prior code, agent config, product, or data
      > was used or shown.*

## Evidence discipline (`CC-7`)

- [ ] **Every row in `/evidence` comes from a real call.** No seeded intake records,
      no fabricated dose events, no invented payment
- [ ] A padded database is a **zeroed parameter**, not a rounding error
- [ ] Ready to grant read-only analytics access if asked

## Submit (T+22.5 → T+23.5 · 17:00–18:00)

- [ ] Public GitHub repo URL + build instructions
- [ ] Live product URL **and** the 3-minute recording — ship both
- [ ] Virality screenshots
- [ ] GTM brief
- [ ] Borderline-starting-point note
- [ ] ⚠️ Handbook submission window is **17:30–18:00**, hard deadline 18:00.
      Be done by 17:30. Late submissions are not scored
