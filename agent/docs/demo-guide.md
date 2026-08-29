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
