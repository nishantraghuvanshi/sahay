# WhatsApp OTP — getting the credentials

**Why WhatsApp and not SMS.** India's TRAI requires DLT registration for all A2P
SMS: an Entity ID, a sender header, and the exact message template registered
with an operator portal. Days to weeks, and Twilio will not deliver to a `+91`
number without it. WhatsApp is not SMS, so none of that applies — this is the
only route to a real phone OTP that can go live the same day.

It is also already the architecture: [TRD §9](TRD.md) puts WhatsApp first on the
escalation ladder, and `.env` has reserved `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID`
since before any of this was built.

**Code is done.** `api/services/delivery.py` has `send_whatsapp_otp()` and
`deliver_phone_otp()`, which tries WhatsApp and falls back to SMS. Verified
against Meta's live endpoint — a deliberately fake token came back
`401 Cannot parse access token`, meaning Meta parsed the request and rejected
only the credential. Nothing is missing but the five values below.

---

## What you are collecting

| `.env` key | What it is | Where from |
|---|---|---|
| `WHATSAPP_TOKEN` | Access token | Step 5 (temp) or Step 8 (permanent) |
| `WHATSAPP_PHONE_ID` | **Phone number ID**, a long number — *not* the phone number | Step 5 |
| `WHATSAPP_OTP_TEMPLATE` | Name of your approved template | Step 6 |
| `WHATSAPP_OTP_LANG` | Template language code, e.g. `en` or `en_US` | Step 6 — must match exactly |
| `WHATSAPP_OTP_HAS_BUTTON` | `true` if the template has a copy-code button | Step 6 |

---

## Step 1 — Register as a Meta developer

<https://developers.facebook.com/> → **Get Started** (top right).

Uses your existing Facebook account and confirms phone + email. **Until this is
done, app creation redirects you to a login or business page rather than the
create wizard** — that is the usual reason "Create App" appears to be missing.

## Step 2 — Have a business portfolio

App creation needs one. Meta usually creates it for you during Step 3; if it
asks, make one with any name. This is a Meta Business portfolio, not a Facebook
Page, and it does not need to be a registered company.

## Step 3 — Create the app

<https://developers.facebook.com/apps/create/>

- **Use case** → **Other**. The WhatsApp-sounding options route into a different
  flow that does not expose the Cloud API.
- **App type** → **Business**. WhatsApp is not offered under any other type.

If the link bounces you to a login, sign in — the URL carries `?next=` and
returns you to the wizard.

## Step 4 — Add the WhatsApp product

In the app's left sidebar: **Add product** → **WhatsApp** → **Set up**.

Meta gives you a **free test number** to send from. You do not need to own a
WhatsApp Business number to demo this.

## Step 5 — Copy the token and phone number ID

You land on the **API Setup** panel. Two values:

- **Temporary access token** → `WHATSAPP_TOKEN`
  Expires in **24 hours**. Fine for testing; do Step 8 before the demo.
- **Phone number ID** → `WHATSAPP_PHONE_ID`
  The long numeric ID under the test number. **Not** the `+1 555…` itself —
  using the phone number here fails.

Same panel, **To** field → **Manage phone number list** → add your own number in
full international form. Test mode only delivers to allow-listed numbers; a
missing one fails with Meta error **131030**.

## Step 6 — Create the authentication template

<https://business.facebook.com/wa/manage/message-templates/> → **Create template**.

- **Category** → **Authentication**. This matters: Meta will not carry a
  verification code in a Marketing or Utility template.
- **Name** → e.g. `otp_verification` → this is `WHATSAPP_OTP_TEMPLATE`.
- **Language** → note the exact code shown (`en` and `en_US` are different) →
  this is `WHATSAPP_OTP_LANG`. A mismatch fails with **132001**.
- Meta writes the body copy for authentication templates. If it includes a
  **copy-code button**, set `WHATSAPP_OTP_HAS_BUTTON=true`.

Approval is usually minutes.

## Step 7 — Fill in `.env` and restart

Uncomment the five lines in `.env` and fill them:

```
WHATSAPP_TOKEN=EAAG...
WHATSAPP_PHONE_ID=123456789012345
WHATSAPP_OTP_TEMPLATE=otp_verification
WHATSAPP_OTP_LANG=en
WHATSAPP_OTP_HAS_BUTTON=true
```

Then clear `DEV_OTP_BYPASS_NUMBERS=` so real delivery is actually exercised, and
restart — settings are cached at boot, so an edit alone changes nothing:

```bash
pkill -f "uvicorn api.main:app"
.venv/bin/uvicorn api.main:app --port 8000
```

Test:

```bash
curl -s -X POST http://localhost:8000/auth/otp/start \
  -H 'content-type: application/json' \
  -d '{"channel":"sms","destination":"+91XXXXXXXXXX"}'
```

The response is always `{"ok":true,...}` by design — it must not reveal whether
a number has an account. **The truth is in the server log**, which records
Meta's verbatim error.

## Step 8 — Permanent token, before the demo

The Step 5 token dies in 24 hours. For anything you are presenting:

<https://business.facebook.com/settings/system-users> → **Add** → name it, role
**Admin** → **Add assets** → assign your app with full control → **Generate new
token** → select the app → tick **`whatsapp_business_messaging`** and
**`whatsapp_business_management`**.

Copy it immediately; Meta shows it once. That value replaces `WHATSAPP_TOKEN`.

---

## Error codes, and what each means

All of these appear verbatim in the API log, prefixed `whatsapp rejected:`.

| Code | Meaning | Fix |
|---|---|---|
| **190** | Token invalid or expired | Regenerate; do Step 8 |
| **131030** | Recipient not on the allow-list | Add the number in Step 5 |
| **132001** | Template not found | Name or language code does not match Step 6 |
| **132000** | Parameter count mismatch | Flip `WHATSAPP_OTP_HAS_BUTTON` |
| **133010** | Phone number not registered | Finish Step 4 setup |

---

## If this fights you

The login flow is already real without it. Email OTP works today over SMTP, and
`DEV_OTP_BYPASS_NUMBERS` runs every rule — generation, HMAC hashing, expiry,
five-attempt lockout, session issue — skipping only the carrier hop.

That is honest to present: phone delivery is pending a regulatory queue, not a
missing feature.

## The alternative, if you want real SMS

MSG91, Gupshup and Kaleyra handle DLT registration as part of onboarding — one
to two days, and it is real SMS so it reaches people without WhatsApp. Doing DLT
yourself with Twilio keeps `send_sms()` exactly as written but takes days to
weeks, and freezes the OTP wording once approved.

## Reference

- Cloud API get started — <https://developers.facebook.com/docs/whatsapp/cloud-api/get-started>
- Sending template messages — <https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates>
