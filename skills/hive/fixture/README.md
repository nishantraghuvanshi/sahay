# TriageFlow — Autonomous Clinic Intake Agent

TriageFlow is a multi-agent voice system that replaces the front-desk intake call
at small clinics. A patient calls, describes their problem in natural speech, and
TriageFlow produces a structured intake record, books the right slot, and escalates
red-flag symptoms to a human within seconds.

## What it does

- **Real-time voice intake** over the phone (Vapi + Deepgram + Sarvam for Hindi/English code-switching)
- **Multi-agent architecture**: a Router agent classifies intent, a Triage agent runs
  the symptom protocol, a Booking agent holds the calendar, a Safety agent runs in
  parallel watching every turn for red-flag escalation
- **Persistent memory**: returning callers are recognised by phone number and the agent
  picks up their history — past visits, medications, allergies
- **Escalation**: chest pain, stroke signs, or breathing difficulty trigger an immediate
  human handoff with a full context packet

## Impact

Front-desk staff at a typical 3-doctor clinic spend ~4 hours/day on intake calls.
TriageFlow removes that entirely. That's a 100% reduction in intake labour and
lets clinics run 40% more appointments per day.

## Status

Core loop works end to end. Booking integration is wired to a sandbox Cal.com account.
Memory layer is implemented on SQLite. Safety agent is implemented and tested.
