# IDEA_SCOPE.md — "Sahay"
### The control plane. If a decision isn't here, it isn't decided.

**T-0 = 18:30 IST, Aug 29** · **Code freeze = 18:00 IST, Aug 30** · **Submission window 17:00–18:00**
Read `PRD.md` for what and why. Read `TRD.md` for how. This file is who, when, and what proof.

---

## 1. The one-sentence scope

> One AI voice line that **calls an ageing parent on schedule to manage medicines**, and **picks up when they call in** — where the inbound call already knows everything the outbound calls learned.

**Track:** Revenue. **Hero moment:** the 2 AM inbound call that doesn't ask who you are.

## 2. Locked decisions — do not reopen during the build

| # | Decision |
|---|---|
| 1 | Declared job = **produce the intake record + handoff**, never "triage the patient" |
| 2 | Primary track = **Revenue**. Memory/Creativity score as product params anyway |
| 3 | **US Twilio number.** Indian DID is impossible in 19h `[V]` |
| 4 | Outbound is **thin** — it exists to seed memory. Inbound is the hero |
| 5 | **No** acoustic distress detection. **No** diagnosis. **No** dispatch claim |
| 6 | Priority is **rule-cited**, and the UI renders the rule string |
| 7 | Product name is **not Voxikin** |
| 8 | Tool contract frozen at **T+1h** and not renegotiated |

## 3. The four lanes

Assigned by function. Drop people in at check-in. **Lane D is not a consolation role — two of six scored surfaces live there.**

### Lane A — Voice
Owns: ElevenLabs agent, all prompts, Twilio wiring, both call directions, resume-after-drop.
**Needs the strongest realtime-voice person on the team. This is the critical path.**
Done when: outbound call completes a dose confirmation; inbound call opens with 3 record facts unprompted; a dropped call resumes with state.

### Lane B — Memory & API
Owns: data model, the 7 tools, priority rules, escalation, safety scorer, handoff link generation.
**Pairs tightly with A. Freeze the contract with A at T+1h, then work independently.**
Done when: all 7 tools return correct shapes under 3s; `upsert_intake` writes every turn; safety scorer runs on every session.

### Lane C — App & handoff
Owns: Emergent caregiver app, care record view, escalation feed, read-only handoff view, pricing page.
**Lowest coupling. Can build against mock JSON from hour 1 — do not wait for B.**
Done when: caregiver sees dose history, observations, escalations; handoff link opens a clean read-only intake record on a phone.

### Lane D — Evidence, revenue, submission
Owns: UPI checkout, unit-economics table, the 3 cold-run scripts and scoring, **the video**, the viral post, README, GTM brief, and **selling to real people in the room**.
Done when: ≥1 real payment received; 3 scored runs recorded; video cut; submission complete.

**Why D matters:** `[V]` stage demos are **top 3 only**. Everyone else is judged from the submission during a **30-minute** window across all teams. The recorded video is the judged artifact. A team where all four people code and nobody owns the video loses on a technicality.

## 4. Timeline

| Window | IST | A — Voice | B — API | C — App | D — Evidence |
|---|---|---|---|---|---|
| T+0→1 | 18:30–19:30 | **ALL FOUR TOGETHER.** Confirm Hive stack. Confirm Emergent requirement. Create empty repo. **Freeze the tool contract (TRD §6).** Buy Twilio number. Split. |
| T+1→5.5 | 19:30–00:00 | Fresh agent. Prompts from zero. Twilio wired. **Outbound call works** | Schema + all 7 tools stubbed then real | Emergent scaffold, mock JSON, care record view | Number bought, pricing page, checkout live, landing copy |
| T+5.5→11.5 | 00:00–06:00 | **Inbound.** Caller resolution. Intake collection. **Resume-after-drop** | Priority rules, escalation, safety scorer, handoff tokens | Escalation feed, handoff view, mobile layout | Write 3 cold-run scripts. Post teaser. Line up 5 buyers |
| T+11.5→17.5 | 06:00–12:00 | Integration + latency + hardening | Integration. Fill unit economics | Wire to real API. Polish | **Record 3 cold runs. Score them.** Start selling |
| T+17.5→20.5 | 12:00–15:00 | Demo-blocking bugs **only** | Demo-blocking bugs **only** | Demo-blocking bugs **only** | **Cut the video.** Close the sale |
| T+20.5→22.5 | 15:00–17:00 | Freeze. README | Freeze. README | Freeze. Deploy live URL | Viral post + screenshots. GTM brief |
| T+22.5→23.5 | 17:00–18:00 | **ALL FOUR: submit.** Repo + live URL + video + virality proof. Flag borderline note. |

**Hard gates.** Miss one, cut scope, don't extend:
- **T+1h** — tool contract frozen
- **T+11.5h (06:00)** — first full end-to-end call, or drop resume-after-drop
- **T+17.5h (12:00)** — feature freeze, absolute
- **T+20.5h (15:00)** — video locked

## 5. The video — 3 minutes, one unbroken take for the demo section

`[V]` Their Demo Prep prescribes 30s context / 30s manual workflow / 2min live. That structure is written for the **top-3 stage slot**. For the submission video, **front-load the working product** — a judge on entry #17 of 30 decides in the first 20 seconds.

1. **0–20s** — Cold open on the hero moment, no setup. Parent dials. Agent: *"Hello Sharma-ji — is this about the chest discomfort you mentioned this morning?"*
2. **20–45s** — Now the context. 149M Indians 60+; 36% have a migrant child; medicines-on-time is the #1 stated worry `[T]`.
3. **45s–2:30** — The full loop, one take: outbound dose call → record updates on screen → inbound call inherits it → 12-field intake fills → priority **with the rule string visible** → caregiver notified **by name** → **drop the call, redial, it resumes**.
4. **2:30–2:45** — The three scored runs, side by side, with the accuracy number.
5. **2:45–3:00** — The real payment confirmation. Close on that. Not on architecture.

**Film all three cold runs.** `[V]` Job-to-be-done L5 requires *"three repeated test cases"* — nobody will run your app for you.

## 6. Risk register

| Risk | Owner | Mitigation | Trigger |
|---|---|---|---|
| Inbound caller ID not exposed as expected | A | Ask-for-number fallback (TRD §6). **Build fallback first** | T+1h |
| Voice latency makes it feel robotic | A | Flash v2.5; trim tool payloads; preload context via dynamic variables | T+6h |
| `upsert_intake` only fires at call end → resume loses everything | B | Write every turn. **Test by hanging up mid-call at T+8h** | T+8h |
| Emergent is mandated and constrains the backend | ALL | Confirm at T-0 before any feature code | T+1h |
| Hive stack forbids something we chose | ALL | Same gate. Nothing before 19:30 | T+1h |
| No real buyer found | D | Start asking at T+12h, not T+20h. Room is full of the ICP | T+12h |
| Live demo dies during judging | D | Video is the primary artifact anyway | — |
| Mentor rules the idea too close to Voxikin | ALL | **§9. Resolve at check-in, before T-0** | 17:00 today |

## 7. Definition of done — the submission

`[V]` Required:
- [ ] Public GitHub repo + build instructions in README
- [ ] Live product URL **or** clean 3-min recording (ship both)
- [ ] Virality screenshots — post performance, impressions, reactions
- [ ] Borderline-starting-point note (§9)
- [ ] GTM brief

Ours:
- [ ] 3 scored cold runs, ≥85% field accuracy, 0 safety failures
- [ ] Real payment confirmation
- [ ] Unit-economics table with rates pulled that day

## 8. Evidence discipline

`[V]` Terms clause 09: *"read-only analytics access, database spot checks, and contact checks with your signups. Refusing verification zeroes that parameter."*

**They check the database.** Every row in `/evidence` must come from a real call. No seeded intake records, no fabricated dose events, no invented payment. A padded DB is a zeroed parameter, not a rounding error.

## 9. Compliance — settle this before T-0

**Unresolved.** You are pre-product with no codebase `[T]`, which puts you in *"an idea you've sketched but never deployed"* `[V]`. But Voxikin is a company in this space, and `[V]` rule 04 says *"if your company builds in this space, you can't demo your existing product."*

**Do this at check-in (17:00–17:30), before kickoff:**

> "I'm a founder — pre-product, no codebase, no launch, never pitched. Prior work is market research and a no-code voice agent I won't touch. If I build from zero today in my domain, is that clean? Does it change if I use the same brand name?"

Get a name. Write down the answer.

**Regardless of the ruling:**
1. Submit under a name that is **not Voxikin**
2. First commit after 18:30. Empty repo before that
3. **Never open `medication-reminder-agent-config.md`**
4. No Voxikin branding, app, or data on screen
5. Flag in submission notes:
   > *Borderline starting point: I am a founder in elder-care voice AI (pre-product, no codebase, never pitched or demoed). This is a from-zero build. No prior code, agent config, product, or data was used or shown.*
6. Confirm to yourselves: **has any of this been pitched or demoed at another event?** `[V]` *"a build already demoed or pitched at another event"* is a hard disqualifier with no borderline path.

## 10. Still open

1. **Roster → lanes.** Who owns A? Realtime voice is the critical path and the likeliest slip.
2. **Product name.** "Sahay" is a placeholder.
3. **The T-0 verifications** — Hive stack, Emergent requirement, caller-ID variable, live per-minute rates.
