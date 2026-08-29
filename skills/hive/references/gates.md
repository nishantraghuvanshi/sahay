# Gates — eligibility, framing lock, submission

Three places where a project loses points it never had a chance to argue about.

---

## Gate 1 — Eligibility (run at `pick`, re-run at `submit`)

Handbook rule 04 and the qualifying-start list. Judged on origin, not quality.

**QUALIFIES**
- A project started from zero today
- A Hive product or model configured from scratch during the buildathon
- **An idea you've sketched but never deployed** — prior research, briefs and specs are fine
- Helper tools and BaaS — Supabase, Sheets, Firebase, Clerk
- AI coding assistants writing the code
- Standard starter scaffolding — Next.js, Vite, FastAPI

**DOES NOT QUALIFY**
- A finished build submitted with only cosmetic changes
- A pre-built agent with minor tweaks done today
- Your existing product in its original form
- Remote contributors or code written off the floor
- A build already demoed or pitched at another event
- Builds on a stack other than The Hive

Ask directly, and record the answer in `.hive/state.json`:

1. Did any file in this repo exist before T-zero? Which, and how much has changed?
2. Is anyone contributing who is not physically on the floor?
3. Has this been demoed or pitched anywhere before?
4. Does the stack satisfy the Hive-stack requirement? (Confirm at kickoff — the handbook
   asserts it without defining it. If unclear, ask a mentor rather than assuming.)

**If prior work is being reused:** the handbook's instruction is explicit —
*"If it's borderline, flag it. Submit anyway and flag 'borderline starting point' in your
notes. Mentors verify before the lineup is locked. **Hiding the origin is an auto-
disqualification.**"* Flagging costs a conversation. Hiding costs the entire submission.

Reusing prior *research* to build fresh code is squarely inside the rules. Porting a prior
*codebase* is the disqualifying case.

---

## Gate 2 — Framing lock (~T+3)

Creativity and Novelty are decided by the idea, not the implementation, and cannot be
retrofitted (see `clock.md`). Once `IDEA_SCOPE.md` is written, the loop treats the framing
as **locked**.

A later tick may propose sharpening the framing. It may not propose replacing it. To
actually change ideas, the human has to say so explicitly — at which point re-run `pick`
from the top, including eligibility.

Why the lock is worth having: mid-build idea drift is the most common way a hackathon team
arrives at hour 20 with two half-products and evidence for neither. Locking is what makes
the score interpretable — every subsequent tick measures the *same* thing.

---

## Gate 3 — Submission (T+23.5 to T+24, hard)

Window: **Aug 30, 5:30–6:00 PM IST.** Late is not scored. There is no appeal —
"Judges' decision is final", and Applybee may "disqualify any participant, at any time".

Required:

| # | Item | Verify by |
|---|---|---|
| 01 | Public GitHub repo URL, with build instructions | Clone it fresh to a temp dir and follow your own README. If a stranger cannot build it, the instructions are not instructions. |
| 02 | Live product URL **or** a clean 3-minute recording | Open the URL in a private window. Play the video start to finish. |
| 03 | Virality screenshots (Track 1) | Analytics panel visible, timestamped. |
| — | Borderline-origin note, if Gate 1 flagged anything | Written in the submission notes, not omitted. |

Plus, from Demo Prep — have the **fallback recording** ready before the window opens:
*"Have a recording ready if the live run drops."* A dropped live demo with no fallback
converts a strong JTBD score into a zero in the room.

Pre-submission smoke test, in this order:
1. `git clone` the public URL into a clean directory — does it exist and is it public?
2. Follow your own README from scratch.
3. Run the repeatability harness one final time; refresh `evidence/jtbd/runs/SUMMARY.md`.
4. Play `evidence/demo/fallback.mp4` end to end.
5. Confirm every claim in the demo script maps to a file in `evidence/`.
