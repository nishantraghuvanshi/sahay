# Real captured Vapi webhook payloads

These files are real Vapi webhook bodies captured from two live phone calls
during the hackathon build, sanitized for a public repo:

- phone numbers replaced with `+15551234567` (customer) / `+15559876543` (caregiver)
- `headers` dropped entirely (only `body` was ever needed)
- recording/log storage URLs replaced with `https://example.invalid/recording.wav`
- the real caller's name replaced with `Test Patient`

Key structure and every type-discriminating value (`type`, `status`,
`endedReason`) are untouched — these are the actual shapes Vapi sent, not
hand-written guesses. They are the source of truth for what the `/webhook`
handler in `src/adapters/transport/vapi.js` must be able to parse.

The two calls sent exactly four distinct event types — `call-started` and
`transcript` (both still handled in `vapi.js`) were never observed:

- `status-update-in-progress.json` — `status-update` with `status: 'in-progress'`
- `status-update-ended.json` — `status-update` with `status: 'ended'` and `endedReason`
- `speech-update.json` — `speech-update`
- `assistant-started.json` — `assistant.started`
- `end-of-call-report.json` — `end-of-call-report`
