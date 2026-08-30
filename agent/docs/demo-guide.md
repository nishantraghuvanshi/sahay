# Demo Guide

## Before You Demo

### Prerequisites
- Bridge server running (`npm start` in va/ directory)
- Vapi assistant created (`node scripts/create-assistant.js`)
- Twilio number configured for inbound (`node scripts/setup-inbound.js`)
- `.env` file with SARVAM_API_KEY, VAPI_PRIVATE_KEY, TWILIO_PHONE set

### Quick Start
1. `cd /Users/anmolsen/Developer/va/va`
2. `npm start`
3. Open `http://localhost:3001/` in your browser

## Demo Flows

### Flow 1: Browser Playground (No Phone Needed)
Best for: Quick demos, video calls, testing prompts

1. Open `http://localhost:3001/playground`
2. Enter parent name (e.g., "रोहन") and drug name (e.g., "Crocin")
3. Select language (Hindi or English)
4. Click "Start Conversation"
5. Allow microphone access
6. The agent greets you first — listen through speakers
7. Speak your response — the agent transcribes and responds
8. Try: "हाँ ले लिया" (yes, taken) → agent confirms and ends call
9. Try: "नहीं अभी नहीं लिया" (no, not yet) → agent reminds and ends call
10. Try: "बुखार है" (I have fever) → agent escalates

Cost: Free (uses Sarvam API directly, no Vapi/Twilio)

### Flow 2: Outbound Call (Real Phone Call)
Best for: Showing the real product experience

1. Open `http://localhost:3001/call`
2. Enter the parent's name, phone number (E.164 format: +91XXXXXXXXXX), drug name
3. Select language
4. Click "Call Now"
5. The agent calls the number within seconds
6. The parent picks up and has a conversation
7. After the call, the outcome is logged to the server console

Cost: ~$0.13/min (Vapi $0.05 + Sarvam $0.034 + Twilio $0.05)

### Flow 3: Inbound Hotline (Call the Agent)
Best for: Letting someone try it themselves

1. Share the Twilio phone number with the person
2. They call the number from any phone
3. The agent answers and starts the medication check flow
4. They respond naturally — the agent handles the conversation
5. After they hang up, the outcome is logged

Cost: ~$0.13/min

## Demo Talking Points

### For Families (B2C)
- "This sounds like a caring healthcare worker checking on your mom"
- "You get the outcome — took medicine, didn't take, or needs help"
- "Works in Hindi — your parents don't need to speak English"
- "90 seconds, done. Not a long annoying call"
- "No app needed on your parent's phone — just a regular phone call"

### For Investors
- "119M ER visits/year in India, 30% mortality from delayed care"
- "Voice is the only interface that works for 60-80 year-old Indians"
- "Plug-and-play architecture — swap any provider via config"
- "Cost: ₹5/call, subscription model ₹499/month"
- "Path to PulseCheck emergency triage — same platform, new use case"

### For Healthcare Partners
- "DPDP Act compliant, data stays in India"
- "Wellness positioning — not a medical device (yet)"
- "Path to CDSCO SaMD Class C for future triage use case"
- "FHIR-ready architecture for ABDM integration"

## Troubleshooting

### Agent doesn't speak
- Check SARVAM_API_KEY is set in .env
- Check server is running (`curl http://localhost:3001/health`)
- Check browser console for WebSocket errors

### Call doesn't connect
- Check VAPI_ASSISTANT_ID is set in .env
- Check VAPI_PRIVATE_KEY is set
- Verify assistant exists: `node scripts/create-assistant.js`

### Poor audio quality
- Use headphones to avoid echo
- Check internet connection
- Try English mode (better STT accuracy for non-native Hindi speakers)

---

## Trying it without ringing anyone

Two things you can run that do not touch a phone.

**The scenario battery** — 24 simulated callers against the real agent:

```bash
cd agent && npm run simulate-elevenlabs -- --all --repeat 3
```

It prints per-scenario pass rates, the outcomes seen across rounds, and LLM
time-to-first-sentence percentiles. Use `--repeat`: outcomes vary run to run,
and a single run cannot tell a regression from variance.

One scenario, with its transcript:

```bash
npm run simulate-elevenlabs -- --scenario refuses_with_reason
```

**Replaying a real call** through the production webhook — envelope, signature,
engine, database — without dialling:

```bash
npm run replay-post-call -- --conversation=conv_xxx --strip-tools
```

`--strip-tools` removes the tool calls, reproducing a call whose agent ended
without reporting an outcome, which is what the analysis backstop is for.

## Placing a call yourself

```bash
cd agent
npm run call -- +918104348262 निशांत Metformin
```

Phone, name, medicine — in that order. Flags work too if you prefer them
(`--phone`, `--name`, `--drug`, and `--caregiver` for the escalation line).

It asks before dialling, because a phone rings in someone's house. `--yes`
skips that; `--no-wait` dials and exits instead of waiting for the transcript.

Before it dials it prints the two sentences the agent will actually say — the
food instruction and the next-call promise — both read from that patient's real
medication rows. An empty one usually means no schedule on file rather than a
bug.

It also refuses to dial on a stale `WEBHOOK_URL`. That is the failure worth
guarding: if the tunnel has rotated, the call still connects and the agent still
talks, but every tool call goes to a host that no longer exists, so nothing is
recorded and the transcript looks perfectly fine.

Afterwards it prints the conversation, what was recorded, the wait before each
reply, and a warning if the agent spoke a bracket tag aloud.

## The two buttons in the app

At the bottom of the Calendar screen, once onboarding is done.

**Demo call.** Runs the real agent against a scripted patient and shows the
conversation as text. No phone rings, nothing is recorded, and it cannot mark a
dose taken or alert anyone. One per caregiver. This is the one to show first.

**Place a real call.** Actually dials the parent's number. The agent talks to
whoever answers and the outcome is written to their dose record like any other
call. One per caregiver, and it asks twice — the second press confirms against
the number it is about to ring.

They are separate routes with separate quotas. Spending the demo does not spend
the real call.

## If a call goes wrong

The agent logs one JSON line per event. The ones worth grepping:

| Event | Means |
|---|---|
| `el_agent_patched` | boot pushed the prompt, tools and webhooks to ElevenLabs |
| `transport_start_failed` | that push failed — usually a stale tunnel. The server stays up |
| `el_tool_dispatched` | a tool call arrived from a live call |
| `el_post_call_processed` | the call ended and the outcome was derived |
| `el_post_call_unauthorized` | a delivery failed its signature — check `ELEVENLABS_POST_CALL_SECRET` |
| `el_init_served` | an inbound call was configured |
| `el_init_resolution_failed` | inbound answered, but the caller could not be looked up |

The full transcript, cost and timings of any call are in the `calls` table and
in ElevenLabs' own conversation record.

