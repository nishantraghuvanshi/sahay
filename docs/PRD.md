# Product Requirements Document
# "Sahay" — the care line that already knows

| | |
|---|---|
| **Version** | 1.0 |
| **Status** | Approved for build |
| **Owner** | Shubh Sankalp Das |
| **Event** | The Hive Hackathon by ApplyBee AI · Startup Park Bangalore |
| **Build window** | T-0 = 18:30 IST Aug 29 2026 → code freeze 18:00 IST Aug 30 |
| **Primary track** | Revenue |
| **Companion docs** | `TRD.md` (technical design) · `IDEA_SCOPE.md` (execution control plane) |

> **Product name is a placeholder.** Do not submit under the Voxikin brand. See `IDEA_SCOPE.md` §9.

**Evidence legend.** Every factual claim in this document carries one:
- `[V]` **Verified** — read from a live official source during preparation
- `[T]` **Team-stated** — asserted by the team, from their own research or records
- `[I]` **Inference** — our reasoning, not a sourced fact

---

# 1. Summary

Sahay is an AI voice line for an ageing parent in India. It **calls out** on a schedule to manage daily medicines and capture how the parent is doing, and it **picks up when they call in** — and the inbound call already knows everything the outbound calls learned.

The parent needs no app, no login, no smartphone. Their entire interface is answering and placing an ordinary phone call. The adult child, living in another city, gets an app showing what happened and pays the subscription.

**The thesis in one sentence:** every product in this category is one-directional and starts cold; the value is in the loop between the two directions.

---

# 2. Problem

## 2.1 The moment

> *"It's 3 PM. I'm presenting to my boss. My mother's 2:30 tablet is still on the table."*

`[T]` India is ageing faster than it is preparing for it, and its children are moving away faster than any support system compensates for.

## 2.2 The funnel — how 149 million people become one missed tablet

`[T]` Sourced from the team's research corpus.

| Step | Figure | Source |
|---|---|---|
| Indians aged 60+ today | **149M** (347M by 2050) | UNFPA India Ageing Report 2023 |
| Live with a chronic condition needing daily medicine | **~50%** (32% with two or more) | BMC Geriatrics 2023 |
| Take five or more medicines daily | **49%** | Frontiers in Pharmacology 2021, 27-study meta-analysis |
| Doses never taken; forgetfulness the #1 reason | **~50%** non-adherence (34–54% cite forgetting) | WHO 2003; Indian T2DM meta-analysis |
| Have a child in another city who cannot check | **36%** | LASI Wave 1 |
| Internal migrants in India | **402M** (28.9% of population) | EAC-PM 2024; NSO 2020-21 |
| Elderly living alone or with only a spouse | **27%** (up from 22% in 2011) | LASI Wave 1 |

`[T]` A missed dose is not a small thing. It is a stroke, a hypoglycaemic episode, or an admission — six months later. Nobody monitors the one variable that decides whether chronic care in India works: *did they take the dose?*

## 2.3 Primary research

`[T]` Team survey, 2026, n=31 adult children of ageing Indian parents (n=30 on chronic conditions).

| Finding | Figure |
|---|---|
| Ranked "taking medicines on time" as their **single top concern** | **58.1%** |
| Falls | 48.4% |
| Diet | 45.2% |
| Doctor visits | 41.9% |
| Emergency response | 38.7% |
| Parents taking 2+ medicines daily | 84% |
| Parents taking 4+ | ~33% |
| Children who don't know the number of medicines at all | 1 in 10 |
| Parents who use a smartphone confidently | **9.7%** |
| Parents who manage only calls and WhatsApp | 58.1% |
| Parents on feature phones | 19.4% |

`[I]` Every runner-up concern already has a funded startup. The #1 concern does not.

## 2.4 Why an app has not solved this

`[T]` **Because the person who has to take the tablet cannot use one.** 90% of parents are not smartphone-confident; a fifth are on feature phones where no app is possible. But `[T]` ~70% of elderly Indians use a mobile phone.

**They can all take a call.** The wedge is the call, not the app.

## 2.5 What fills the gap today

1. The spouse, if alive and able.
2. The adult child's daily guilt-driven check-in call. `[T]` ~5 min/day × 365 = **30+ hours a year** of emotional labour.
3. Nothing. Silent non-adherence, then hospitalisation.

## 2.6 The second problem nobody solves

`[I]` When something does go wrong, the parent or a neighbour calls someone — and that someone knows nothing. Not the medicines, not the conditions, not the allergies, not what the doctor said last month, not what the parent reported feeling last Tuesday.

The context exists. It is just never where it is needed, when it is needed.

---

# 3. Market

`[T]`

| | |
|---|---|
| India senior-care industry | **$7B today → $12B in five years** (NITI Aayog, Feb 2024) |
| Reachable end users | 149M Indians 60+, virtually all reachable by phone |
| Addressable payers | the 36% with a migrant child |
| Global 60+ population | doubles to 2.1B by 2050 (WHO) |
| Global long-term-care tech market | $5.62B (2025) → $11.62B (2034), 8.4% CAGR |

## 3.1 Why now

1. `[I]` **Voice crossed the line.** Sub-second latency, natural turn-taking, and real Indian-language voices mean an AI call now reads as a call.
2. `[I]` **Distribution is already solved.** Every parent owns the endpoint. No install, no onboarding, no learning curve.
3. `[I]` **The payer is digital.** The child discovers, subscribes, and manages from a phone.

---

# 4. Users

Two people. The whole product design flows from the split.

## 4.1 The parent — the user, not the customer

| | |
|---|---|
| **Age** | 60+ |
| **Language** | Hindi-first or other Indic language; some English |
| **Tech** | `[T]` 9.7% smartphone-confident. Assume a basic phone that receives and places calls |
| **Health** | `[T]` hypertension 50%, diabetes 46.7%, arthritis 46.7%, cardiac 23.3%, thyroid 23.3% |
| **Medicines** | 2–5 daily, timing-sensitive, food-dependent |
| **Interface** | **A phone call. Nothing else. Ever.** |
| **Wants** | A brief, polite, human-feeling call in their own language. Not to be spoken to like a child |
| **Pays** | No |

**Design consequences.** Slow turn-taking. Short sentences. No jargon. Address by respectful name. Never require a keypad press. Never require them to remember anything between calls.

## 4.2 The adult child — the customer

| | |
|---|---|
| **Age** | 28–45 |
| **Location** | A different town, city, state, or country. **Not only NRIs** |
| **Tech** | Smartphone-native, salaried, digitally payable |
| **Wants** | Certainty the dose was taken. Alerts only when they matter. Zero daily effort |
| **Feels** | Guilt, and the low-grade dread of a phone call at an odd hour |
| **Pays** | **Yes** |

`[I]` **This persona is physically present at the hackathon.** Startup Park Bangalore, 24-hour build: the room is full of 28–45 year olds who moved cities for work and have parents elsewhere. That is the Revenue track argument in §17.

## 4.3 The third party the product must serve

`[I]` **Whoever receives the parent when something happens** — a neighbour, a relative who arrives, a clinic's intake desk. They are not a user, they never log in, and they need one thing: a readable summary, immediately, from a link. This is why the handoff view exists.

---

# 5. Competitive position

`[T]` From the team's competitive research.

| Competitor | Market | Model | Closeness | Gap we exploit |
|---|---|---|---|---|
| **Edesy** (India) | India | B2B, ₹4–6/min, packs ₹1,499–14,999 | 9/10 on use case | Sells voice-AI minutes wholesale across a dozen verticals. No consumer packaging, no focused elder product |
| **ElderVoice** (US) | USA | B2C, $19/$49 mo | 9/10 | Validates caregiver-pays exactly. English-only, US-only |
| **Zangy** (US) | US | B2C, $9.99/mo + per-min | 8/10 | Early. Voice-cloning is the interesting axis |
| **Carissa** (India) | India | B2C ₹1,499/mo | Adjacent | **App-and-wearable-first — requires the parent to own and use a smartphone.** Exactly the assumption our wedge rejects |
| Dispensers & reminder apps | Global | Hardware/app | Low | Assume smartphone fluency or new hardware; both fail the demographic |

## 5.1 The unclaimed intersection

`[I]` Nobody combines: **(a)** an outbound voice adherence *protocol*, **(b)** Indian languages, **(c)** packaged D2C for the distant child — **and (d) an inbound line that inherits the record.**

(a)+(b)+(c) is a good company. **(d) is what makes it different**, and (d) is what we build this weekend.

## 5.2 The one-directional problem, stated as a table

| | Direction | What it knows when the call starts |
|---|---|---|
| Reminder bots — ElderVoice, Zangy, Edesy | outbound only | the schedule |
| Triage / symptom agents | inbound only | **nothing** |
| **Sahay** | **both** | **the full care record** |

---

# 6. Product principles

`[I]` These resolve arguments during the build. When two options are both reasonable, the principle decides.

| # | Principle | What it rules out |
|---|---|---|
| P1 | **The parent's interface is a phone call.** | Any parent-side app, SMS requiring reading, keypad menus, IVR trees |
| P2 | **The agent never holds state.** All memory lives behind the API. | Conversation-scoped memory, prompt-stuffed history |
| P3 | **Capture, never interpret.** | Diagnosis, dosing advice, symptom explanation, urgency as a medical claim |
| P4 | **Every automated judgment cites its rule.** | "P1 — cardiac". Correct form: "P1 — rule: reported breathing difficulty" |
| P5 | **If it isn't in the record, it wasn't captured.** | Anything held only in a transcript |
| P6 | **Never claim an action the system did not take.** | "Help is on the way", "I've called an ambulance" |
| P7 | **Write to the record every turn, not at call end.** | Any design where a dropped call loses progress |
| P8 | **The demo must survive a hostile judge.** | Staged data, seeded records, unverifiable claims |

---

# 7. The declared job

> **Maintain a living care record through scheduled outbound calls, and when the parent calls in, produce a complete structured intake record and hand it off — without the parent repeating anything the system already knows.**

## 7.1 Why not "triage the patient"

`[V]` The rubric's heaviest parameter, Job-to-be-done, requires at L5: *"85%+ task success across a minimum of three repeated test cases... without judge/builder intervention."*

| | "Triage the patient" | **"Produce the intake record + handoff"** |
|---|---|---|
| Ground truth | none obtainable in 24h | **12 defined fields, checkable** |
| Measurable | no | **field-level accuracy across 3 cold runs** |
| Medical liability | high | **none — capture only** |
| Demo failure mode | a hallucinated reassurance on camera | a missing field |
| `[I]` Rubric ceiling | **L3** | **L5** |

`[V]` The idea-card's own stated posture is *"Public Services and Utility 5/5"* — a dimension that **does not exist** on the scored board. The tracks are Virality, Revenue, Novelty. Reframing the job moves the product onto a column that is actually scored.

---

# 8. User journeys

## J1 — Caregiver onboarding (one time, ≤3 minutes)

1. Caregiver signs up on the web app. Name, phone, relationship.
2. Adds the parent: name, phone (E.164), language, age, address.
3. Adds clinical context: known conditions, known allergies, doctor name and number.
4. Adds medicines — name, dose, times, with/without food. Marks at most one as **priority medicine**.
5. Sets meal times (breakfast / lunch / dinner) so dose slots can be placed sensibly.
6. **Reviews and explicitly signs off the schedule.** No call is placed before sign-off.
7. Caregiver is told to inform the parent that these calls are coming.
8. System places a **warm introduction call** — the agent introduces itself, names who set it up and why, and reminds nothing on this first call.

## J2 — Outbound dose call

1. Scheduler fires at the dose slot.
2. Session opened, `direction=out`, care context preloaded.
3. Agent greets by respectful name, states which medicine and which slot.
4. Asks whether the dose was taken.
   - **Taken** → logged `confirmed`.
   - **Not yet** → agent offers to call back in a set interval → logged `deferred`.
   - **Refused / cannot** → logged `missed`, reason captured.
5. One short wellbeing question. Free-text answer captured verbatim.
6. If the answer contains a red flag → agent does **not** interpret it; says *"please contact your doctor now"*, tells the parent it is informing the caregiver **by name**, and escalates.
7. Session closed. Transcript scored for safety.

## J3 — Inbound call (the hero path)

1. Parent dials the number.
2. **Before the agent speaks**, the caller number resolves to a patient record.
3. If an interrupted session exists within the resume window, it is resumed. Otherwise a new session opens.
4. Agent opens **already knowing** — greets by name, and where relevant references something from the record: *"Is this about the chest discomfort you mentioned this morning?"*
5. Agent collects only the fields it does not already hold — six of twelve (§9.2).
6. Every answer is written to the record **on the turn it is given**.
7. Priority is computed from deterministic rules and stored **with the rule text**.
8. Caregiver is notified by name, at a level set by the escalation matrix (§12).
9. A handoff link is generated for whoever will receive the parent.
10. Session closed. Transcript scored for safety.

## J4 — Resume after a dropped call

1. Call ends with status other than `completed`. Session stays resumable for a fixed window.
2. The same number dials back.
3. Caller resolution returns the open session and everything captured so far.
4. Agent resumes explicitly: *"I have you, {name} — {complaint}, about {n} minutes ago. I still need to know {first missing field}."*
5. **The parent never re-answers a question they have already answered.**

## J5 — Caregiver receives an escalation

1. Message arrives naming the parent, what was reported, the priority, **and the rule that produced it**.
2. Link opens the intake record.
3. Caregiver can forward the handoff link to whoever is physically with the parent.

## J6 — Handoff recipient

1. Opens a link. No login.
2. Sees, on one phone screen: patient identity, chief complaint verbatim, onset, responsiveness, breathing, location, current medicines, allergies, conditions, callback number, priority and its rule.
3. Read-only. Nothing to configure, nothing to install.

---

# 9. Conversation design

## 9.1 Voice rules (apply to every call)

| Rule | Reason |
|---|---|
| One question per turn | `[T]` Older speakers lose multi-part questions |
| Sentences under ~15 words | Comprehension over the phone |
| Respectful address (`Sharma-ji`), never first-name-only | Cultural register |
| Accept Hindi, English, or a mix within one sentence | `[T]` Code-switching is the norm, not the exception |
| Never require a keypad press | P1 |
| Confirm back what was heard before writing a clinical field | Accuracy on the scored fields |
| Silence ≥6s → one gentle re-prompt, then close gracefully | Avoids a hung call |
| Never say a number, dosage, or medical term the record does not contain | P3 |

## 9.2 The intake schema — 12 fields

`[I]` This schema **is** the scored artifact. Completeness = captured ÷ 12.

| # | Field | How obtained | Asked? |
|---|---|---|---|
| 1 | Caller identity + relationship | asked | ✅ |
| 2 | Patient identity | **inherited from record** | — |
| 3 | Chief complaint, verbatim | asked | ✅ |
| 4 | Onset time | asked | ✅ |
| 5 | Responsive (yes / no / unsure) | asked | ✅ |
| 6 | Breathing (normal / difficult / unsure) | asked | ✅ |
| 7 | Location | **prefilled**, confirmed | ✅ (confirm only) |
| 8 | Current medicines | **inherited** | — |
| 9 | Known allergies | **inherited** | — |
| 10 | Known conditions | **inherited** | — |
| 11 | Callback number | **inherited from caller ID** | — |
| 12 | Priority + cited rule | **computed** | — |

**Six of twelve are inherited.** That is the product, expressed as a number. `[I]` A cold-start competitor must ask all twelve, from a distressed caller, at 2 AM.

## 9.3 Turn budget

`[I]` Target: **complete intake in ≤7 parent turns.** A cold-start equivalent needs 12–15. This is a stated benchmark in the demo.

---

# 10. Functional requirements

Acceptance criterion in the right column is the test. If it cannot be demonstrated, the requirement is not met.

## 10.1 Onboarding

| ID | Requirement | Acceptance |
|---|---|---|
| FR-1 | Caregiver can create an account and add a parent | Record exists with phone in E.164 |
| FR-2 | Caregiver can add medicines with dose, slots, food rule, priority flag | Dose slots generated on the calendar |
| FR-3 | Caregiver can record conditions, allergies, doctor, address | All appear in agent context on the next call |
| FR-4 | **No call is placed before explicit schedule sign-off** | Attempting to schedule without sign-off is refused |
| FR-5 | First call to any new parent is a warm introduction, not a reminder | Introduction call contains no dose prompt |

## 10.2 Outbound

| ID | Requirement | Acceptance |
|---|---|---|
| FR-6 | Place a call at each dose slot | Call initiated within 60s of slot time |
| FR-7 | Agent greets by name with medicine and slot preloaded | Zero clarifying questions about identity |
| FR-8 | Record dose as confirmed / deferred / missed with reason | Row written before call ends |
| FR-9 | Capture one wellbeing response verbatim | Observation row with severity |
| FR-10 | Red flag triggers escalation without interpretation | Escalation row + no diagnostic language in transcript |

## 10.3 Inbound

| ID | Requirement | Acceptance |
|---|---|---|
| FR-11 | Resolve caller number to a patient **before the first agent turn** | Opening line contains the parent's name |
| FR-12 | Agent references ≥3 record facts unprompted in the opening exchange | Verified on recording |
| FR-13 | Ask only the fields not already held | ≤7 parent turns to full intake |
| FR-14 | Write each captured field **on the turn it is given** | Hang up mid-call; partial record persists |
| FR-15 | Compute priority from deterministic rules and store the rule text | `priority_rule` non-empty on every record |
| FR-16 | Notify the caregiver by name | Message names both parent and caregiver |
| FR-17 | Generate a shareable read-only handoff link | Link opens without login on a phone |
| FR-18 | Unknown caller number handled gracefully | Agent asks for the number, then proceeds identically |

## 10.4 Continuity

| ID | Requirement | Acceptance |
|---|---|---|
| FR-19 | Dropped session remains resumable for the configured window | Session status `dropped`, still open |
| FR-20 | Redial from the same number resumes with everything captured | No question is repeated |
| FR-21 | Agent states what it already has on resume | Opening line names complaint and elapsed time |
| FR-22 | Context is continuous across direction | Morning outbound observation is referenced on the evening inbound call |

## 10.5 Caregiver app

| ID | Requirement | Acceptance |
|---|---|---|
| FR-23 | Care record view: identity, conditions, allergies, doctor, medicines | Matches DB |
| FR-24 | Dose history with status per slot | Reconciles with `dose_events` |
| FR-25 | Observations timeline, verbatim | Reconciles with `observations` |
| FR-26 | Escalation feed with priority **and rule text rendered** | Rule string visible in UI |
| FR-27 | Copy handoff link | Link works from another device |

## 10.6 Commercial

| ID | Requirement | Acceptance |
|---|---|---|
| FR-28 | Public pricing page with tiers | Live URL |
| FR-29 | Working UPI checkout | A real payment completes |
| FR-30 | Successful payment activates a subscription record | Row written, visible in app |

---

# 11. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Agent response latency, end of parent speech → start of agent speech | `[I]` **≤1.2s p50, ≤2.0s p95** |
| NFR-2 | Tool call round trip | **≤800ms p95**, hard timeout 3s |
| NFR-3 | Caller resolution before first agent turn | ≤500ms |
| NFR-4 | Languages at launch | Hindi + English, including mixed within a sentence |
| NFR-5 | Escalation delivery after red flag | ≤30s |
| NFR-6 | A tool failure must never produce agent silence | Always HTTP 200 with `{ok:false}`; agent has a scripted fallback line |
| NFR-7 | No credential in the repo | `.env` gitignored from commit 1; keys rotated after the event |
| NFR-8 | Handoff view usable on a phone, one screen, no login | Verified on a real handset |
| NFR-9 | Every call produces a stored transcript and a safety verdict | 100% of sessions |

---

# 12. Safety requirements — blocking, not advisory

`[T]` Inherited from the team's existing safety posture and tightened for this build.

| ID | Requirement |
|---|---|
| SR-1 | **No diagnosis. No dosing guidance. No treatment suggestion. No interpretation of what a symptom means.** |
| SR-2 | On any red flag the only move is: acknowledge → *"please contact your doctor now"* → escalate by name |
| SR-3 | **Never state that help has been dispatched.** No dispatch integration exists |
| SR-4 | Priority is rule-derived and rule-cited. `P1 — rule: reported breathing difficulty`, never `P1 — cardiac` |
| SR-5 | Consent: caregiver onboards and consents; parent is pre-informed; parent may ask for calls to stop and that must be honoured |
| SR-6 | Every transcript is automatically scored against SR-1…SR-4. **A violation is a failed run, not a warning** |
| SR-7 | No production or third-party personal data. Test only on team members' own phones, with their consent |

## 12.1 Escalation matrix

| Trigger | Priority | Caregiver channel | Handoff link |
|---|---|---|---|
| Unresponsive reported | P1 | Message + call | Yes |
| Breathing difficulty | P1 | Message + call | Yes |
| Chest complaint, age > 40 | P1 | Message + call | Yes |
| Acute onset with red-flag symptom | P2 | Message | Yes |
| Priority medicine missed **and** symptom reported | P2 | Message | Yes |
| Priority medicine missed, no symptom | P3 | Message | No |
| Two or more doses missed same day | P3 | Message | No |
| Single missed dose | — | Daily summary only | No |
| Parent did not answer at a priority slot | P2 | Message | No |

---

# 13. Edge cases

| Case | Behaviour |
|---|---|
| Caller number not in any record | Agent asks for the number to look up, then proceeds identically. **Never invents a record** |
| Someone other than the parent calls (neighbour, relative) | Field 1 captures identity and relationship. Everything else unchanged |
| Parent hangs up mid-intake | Partial record persists; session resumable; redial resumes |
| Two calls from the same number in quick succession | Second resumes the first, does not create a duplicate |
| Parent answers in a language mid-sentence switch | Handled; no clarification round-trip |
| Parent says something clinical the record contradicts | Capture verbatim, flag the discrepancy in the record, **do not adjudicate** |
| Parent asks "should I take a double dose?" | SR-1 applies. Refuse, redirect to doctor, escalate |
| Parent asks the agent to stop calling | Honour it, log it, notify caregiver |
| Dose slot arrives while a call is active | Queue, do not dial over an active session |
| Tool returns an error | Agent uses its scripted fallback line and continues; never goes silent |

---

# 14. Out of scope — and why

`[I]` Each of these is cut for a scoring or safety reason, not for time.

| Cut | Reason |
|---|---|
| **Acoustic distress / voice pitch detection** | Unverifiable across 3 cold runs; invites a challenge that cannot be won. The idea-card recommends it — deliberately ignored |
| Any diagnosis, dosing advice, symptom interpretation | SR-1. Also what makes the job verifiable |
| Ambulance / 108 / 112 dispatch | No integration exists. Claiming it is a lie on camera |
| Full outbound protocol — food-check, 30-min callback, stay-on-line | Outbound exists here only to seed memory |
| Refill tracking, appointment reminders, medicine ordering | Not on the demo path |
| Voice cloning / familiar-voice option | Not on the demo path |
| Multi-language beyond Hindi + English | Not on the demo path |
| **Any app for the parent** | P1. Violates the core thesis, permanently |

---

# 15. Pricing and packaging

| Tier | Price | Includes |
|---|---|---|
| Trial | Free, 7 days | 1 dose slot/day, inbound line |
| **Care** | **₹499 / month** | Up to 2 dose slots/day, inbound line, caregiver app, escalations |
| **Care+** | **₹999 / month** | Unlimited slots, priority-medicine alerts, handoff links, appointment reminders |

`[V]` Benchmarks: Carissa ₹1,499/mo · ElderVoice $19 / $49 · Zangy $9.99 + per-minute · Edesy ₹4–6/min.

`[I]` We price below the Indian consumer benchmark and far below per-minute platform pricing, and we bill on outcome (adherence) rather than minutes.

**Unit economics must be computed from live rates on build day** — see `TRD.md` §27. Do not state a margin in the demo that was not measured. `[I]` "What does a call cost you?" is the most likely Revenue challenge from a judge.

---

# 16. Metrics

## 16.1 Product metrics (what the business would run on)

| Metric | Definition |
|---|---|
| Adherence rate | confirmed doses ÷ due doses, per patient per week |
| Answer rate | calls answered ÷ calls placed |
| Escalation precision | escalations a caregiver marked useful ÷ total |
| Intake completeness | fields captured ÷ 12 |
| Turns to complete intake | parent turns from first to twelfth field |
| Context inheritance rate | inherited fields ÷ 12 |

## 16.2 Demo metrics (what gets scored this weekend)

| ID | Metric | Target |
|---|---|---|
| S1 | Intake field accuracy across 3 cold runs | **≥85%** |
| S2 | Record facts named unprompted on inbound opening | **≥3** |
| S3 | Resume after drop with zero re-collection | **pass** |
| S4 | Escalation delivered, naming caregiver | **≤30s** |
| S5 | Safety violations across all recorded runs | **0** |
| S6 | Real paid subscriptions during the event | **≥1** |
| S7 | Turns to complete intake | **≤7** |

---

# 17. Rubric mapping

`[V]` Rubric language quoted from the live handbook. `[I]` Level targets are our assessment.

| Parameter | Target | What earns it |
|---|---|---|
| **Job-to-be-done** | **L5** | *"85%+ across a minimum of three repeated test cases... without judge/builder intervention"* — S1, filmed |
| **Memory & Context** | **L5** | *"context survives sessions, channels, tools, and handoffs"* — two directions, two channels, a handoff, cited business rules |
| **Creativity** | **L4** | *"several original choices reinforce one another"* — outbound is what makes inbound smart; one mechanism, not two features |
| **Impact** | **L4–L5** | `[T]` n=31 primary + LASI + UNFPA + NITI Aayog. Named user, named frequency, named cost |
| **Delight** | **L4–L5** | *"handles the user's hardest moment with judgment"* — the 2 AM call that does not make you repeat yourself |
| **Revenue (track)** | **L5** | *"immediate live revenue generated during the hackathon"* |

## 17.1 Why Revenue is the primary track

`[I]` Three reasons:

1. **The ICP is in the room.** Nobody else's target customer is the attendee list.
2. **Revenue L5 is the cheapest L5 on the board** — one real transaction, versus a judge-taste verdict for Novelty L5 or an audience-size lottery for Virality L5.
3. **It costs nothing.** Memory and Creativity are **product** parameters, scored on every project regardless of track. The bidirectional-memory story scores either way.

---

# 18. Release criteria

Ship only if all of these hold:

- [ ] Three cold runs recorded, ≥85% field accuracy, **zero** safety failures
- [ ] Inbound opening names ≥3 record facts, unprompted, on camera
- [ ] Resume-after-drop demonstrated in one unbroken take
- [ ] Escalation naming the caregiver, delivered on camera
- [ ] Handoff link opened on a second physical device on camera
- [ ] At least one real payment received and shown
- [ ] Unit-economics table filled with rates pulled that day
- [ ] Public repo with working build instructions
- [ ] Borderline-starting-point note included in submission

---

# 19. Assumptions and dependencies

| # | Assumption | If wrong |
|---|---|---|
| A1 | `[V]` A purchased Twilio number supports inbound and outbound | Fall back to SIP trunking |
| A2 | `[V]` ElevenLabs agents support Hindi | English-only demo; weakens Impact narrative |
| A3 | `[I]` Inbound caller ID is exposed to the agent | Ask-for-number fallback, one extra turn |
| A4 | `[I]` Emergent is optional, not mandated | Hand-build the app; costs ~6h |
| A5 | `[I]` The Hive stack permits this architecture | **Blocking.** Resolve at T-0 before any feature code |
| A6 | `[I]` A buyer can be found in the room | Revenue drops L5 → L4 on cost-reduction metric |
| A7 | `[V]` Outbound to India only from a non-Indian number | US number; stated openly in the demo |

---

# 20. Open questions

1. Product name. "Sahay" is a placeholder throughout.
2. Resume window duration — proposed 15 minutes, unvalidated.
3. Whether the wellbeing question should vary by day or stay fixed for consistency in scoring.
4. Whether Care+ should include the handoff link or whether it belongs in every tier for safety reasons.
5. Which two Indian languages follow Hindi and English.

---

# 21. Glossary

| Term | Meaning |
|---|---|
| **Care record** | The full stored state for a patient: identity, clinical context, medicines, dose history, observations |
| **Care context** | The subset of the care record injected into an agent at call start |
| **Caregiver** | The paying adult child |
| **Dose slot** | A scheduled time at which a specific medicine is due |
| **Handoff view** | Read-only, no-login web page rendering one intake record |
| **Inherited field** | An intake field filled from the record rather than asked |
| **Intake record** | The 12-field structured artifact produced by an inbound call |
| **Priority rule** | The literal text of the deterministic rule that produced a priority |
| **Red flag** | A reported symptom matching the escalation matrix |
| **Resume window** | Period after a dropped call during which a redial continues the same session |
| **Session** | One call, inbound or outbound, with a lifecycle and a transcript |
