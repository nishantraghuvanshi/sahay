# Playbooks — how to actually move a level

Recipes for the level-ups that come up most. Each is scoped to fit inside one build block.

---

## JTBD L3 → L5 · the repeatability harness · ~1.5h · highest points-per-hour on the board

L5 wants "85%+ task success across a minimum of three repeated test cases … without
judge/builder intervention." Three logged runs beat one flawless live demo, because a
single run cannot demonstrate a rate.

1. Write down the **declared job** as one sentence with an observable end state. "Caller
   describes a symptom → a real appointment row exists in the sandbox calendar."
2. Pick ≥3 cases that differ *meaningfully* — not three happy paths. One typical, one
   messy (accent, ambiguity, interruption), one edge (red flag, missing data).
3. `scripts/repeat.sh` runs the job per case and writes `evidence/jtbd/runs/run-NN.json`
   with `completed`, `intervention`, `artifact`, `failure`.
4. `SUMMARY.md` tabulates: cases, passes, rate, date, command to reproduce.
5. Run it. A failing run is **information, not a setback** — it is the only way you learn
   what breaks before a judge finds it.

Do this early. It doubles as your regression signal for the rest of the build.

## Memory L2 → L4 · the restart test · ~1h

L2 → L3 is usually not a storage problem, it is a **wiring** problem: the store exists and
nothing reads it. Check first — `grep -rn "recall(" src/` returning nothing means the
memory layer is decorative.

1. Wire retrieval into the flow so an earlier answer is reused instead of re-asked.
2. Add identity: who is this, what may they access. L3 says *authenticated*.
3. Kill the process mid-task. Restart. Resume without the user restating anything. Log
   both halves to `evidence/memory/cross-session.log` → **L4**.
4. For L5, add one governing business rule applied from context across a tool handoff.

## Delight L2 → L4 · the worst-moment pass · ~45min · cheapest late lever

Scored at friction, not on the happy path. A perfect success run is L2.

1. Name the user's hardest moment in one sentence. Bad news, a failure, an ambiguity.
2. Force it. Break the integration, feed the ambiguous input.
3. Rewrite that response to: say the true thing plainly · not alarm · state what happens
   next · preserve progress made so far. Never expose raw system output.
4. For L5, answer the question they have not asked yet — the *next* concern.
5. Transcript → `evidence/delight/failure-path.md`.

## Impact L2 → L4 · sourcing the number · ~45min

L2 is almost always an unsourced claim, and shrinking the claim raises the score.

1. State the metric precisely: what, whose, per what period.
2. Find the baseline — a published figure, or phone two or three real operators. A named
   person you actually asked is a stronger source than a statistic you cannot link.
3. Show the arithmetic from baseline to claim. 10–30% = L4, >30% = L5, but only with
   steps a judge can follow.
4. Write the counter-argument yourself and answer it. L4 must "survive realistic challenge."

## Revenue L1 → L3/L4 · ~1h

L3 is a **functioning** test-mode checkout (Stripe/UPI) or a pricing tier with defensible
buyer ROI. L4 needs willing-to-pay evidence — and a hackathon floor is full of potential
buyers. A signup sheet with real names and consent to be contacted is L4 evidence;
clause 09 lets judges phone them, so only collect people who would confirm.

## Virality L1 → L3/L4 · post EARLY

Impressions compound over hours. The post is a build artifact with a deadline of roughly
T+8, not a submission-day task. Lead with the *problem and the moment of surprise*, not the
stack — same rule as the demo. Screenshot the analytics panel at several intervals.

## Creativity / Novelty · framing, not features

If these are low at a mid-build tick, adding features will not fix them. Finish the
sentence: *"Everyone assumes this problem requires ___. We remove that assumption by ___."*
If you cannot, you are at L1–L2 and the honest options are (a) sharpen the framing now,
while `clock.md` still allows it, or (b) accept the level and spend the hours on JTBD and
Delight, where the points are cheaper.

## Demo · the 3-minute thread

From Demo Prep — one thread, problem → pain → agent → outcome:

- **0:00–0:30** business context, plain words, no tech
- **0:30–1:00** what happens manually today: how many people, how much time, where it hurts
- **1:00–3:00** the live demo, narrated. End on the working product.

Avoid: opening with the stack · "anyone can use this" · no baseline · no fallback
recording · ending on architecture. Write it to `DEMO.md` and rehearse the cold open aloud.
