# How we work

Six rules. Everything else is zero ceremony — no PR reviews, no branch protection, no
commit conventions, no issue tracker. Process overhead is what kills a 24-hour build.

---

## 1. Own your directory. Don't write outside it.

Git only fights you when two people edit the same file. Four people on one branch is
painless if nobody strays.

| Lane | Owns, exclusively |
|---|---|
| **A — Voice** | `agent/` |
| **B — Memory & API** | `api/`, `scripts/mock_api.py`, `scripts/seed.py` |
| **C — App & handoff** | `app/`, `handoff/` |
| **D — Evidence & revenue** | `evidence/`, `scripts/cold-runs/`, `README.md`, `docs/GTM.md` |

Need something changed outside your lane? Ask the owner. It's faster than the merge.

## 2. One shared file, one owner.

`agent/tools.json` is the only thing two lanes depend on.
**Only Lane B edits it, and only before the freeze. After the freeze, nobody.**
That is what "frozen" means — it is the interface both A and B built against.

## 3. `git pull --rebase` before every push.

```bash
git pull --rebase && git push
```

Linear history, no merge commits, and the repo reads cleanly for a judge who opens it.
Push every 20–30 minutes. Small and often beats one big drop at 4 AM.

## 4. Record decisions in `docs/DECISIONS.md`.

Append-only, one line, thirty seconds:

```
21:40 · V1 resolved — ElevenLabs custom LLM endpoint → Hive router. Confirmed w/ mentor.
23:15 · Dropped the location confirm turn, prefill only — saves a turn against the ≤7 budget.
```

Reversing an earlier decision? Add a new line. Don't edit the old one — the trail matters.
This stops the 4 AM argument about whether something was already settled, and it's where
Lane D gets the material for the README and GTM brief.

## 5. Checkpoints: push, pull, smoke, one line each.

The gates already exist — **T+5 · T+8 · T+11.5 · T+14 · T+17.5**. At each one:

1. Everyone pushes
2. One person pulls fresh and runs the smoke test
3. Everyone posts one line in the channel: **done / blocked**

Ten minutes. No meeting.

## 6. Stop restructuring at T+11.5.

Feature freeze is T+17.5, but *structural* change should stop six hours earlier.
After T+11.5: fill in and fix. No new abstractions, no renames, no moving files.

---

## The checklists — Notion vs. this repo

Both copies exist on purpose. They hold different things.

| | Lives in | Changes |
|---|---|---|
| **State** — what's ticked | **Notion** | Constantly, by four people |
| **Content** — what needs doing | **This repo** | Rarely, deliberately |

- **Tick boxes in Notion.** That's the live surface during the build.
- **Change the plan in the repo first** — add, drop, or reword a task in the `.md`, push it,
  then reflect it in Notion. Plan changes are rare; state changes are constant.
- **State never flows back to git.** The repo checklists staying unticked is correct —
  they're the plan and the reasoning behind it, kept in the repo as context for anyone
  reading the code.
- **At feature freeze (T+17.5), export Notion once** to `evidence/final-checklist.md`.
  That snapshot is the record of what actually got done, and it belongs with the evidence.

One export at one moment, instead of continuous sync.

---

## Things that will get us disqualified

Not style preferences. These are the handbook's rules.

- **A credential in any commit.** `.env` is gitignored from commit 1. If a key does land in
  git, **rotate it immediately** — reverting is not enough, it's in the history
- **Anything from the old archive.** It lives outside this repo at
  `~/Desktop/projects/sahay-archive/` and stays there. Don't open it, don't copy from it,
  don't reference it
- **A seeded row in `/evidence`.** Terms clause 09 permits database spot checks and contact
  checks with signups. Every row comes from a real call. A padded database is a **zeroed
  parameter**, not a rounding error
- **A safety violation in a recorded run.** Any FAIL invalidates that run. Re-run it
- **Hiding the origin.** The borderline-starting-point note goes in the submission, worded
  accurately
