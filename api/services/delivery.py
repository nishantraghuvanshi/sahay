"""spec: TRD §9

WhatsApp -> SMS -> voice call on P1. Failed send recorded, never silent.

Only the SMS and email legs exist so far — they are what caregiver auth needs.
The escalation ladder inherits `send_sms` when Lane B builds it.

Every sender returns a `Delivered` rather than raising: a failed OTP send must
become a message the caregiver can act on, not a 500. "Never silent" cuts both
ways — the failure is returned and logged, not swallowed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from api.config import Settings

log = logging.getLogger(__name__)

TWILIO_SMS_URL = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
RESEND_URL = "https://api.resend.com/emails"
TIMEOUT_S = 10.0


@dataclass(frozen=True)
class Delivered:
    ok: bool
    detail: str = ""


async def send_sms(settings: Settings, to_e164: str, body: str) -> Delivered:
    if not settings.sms_configured:
        log.error("SMS not configured — set TWILIO_ACCOUNT_SID / AUTH_TOKEN / NUMBER")
        return Delivered(False, "sms_not_configured")

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(
                TWILIO_SMS_URL.format(sid=settings.twilio_account_sid),
                auth=(settings.twilio_account_sid, settings.twilio_auth_token),
                data={"To": to_e164, "From": settings.twilio_number, "Body": body},
            )
    except httpx.HTTPError as exc:
        log.exception("twilio sms transport failure")
        return Delivered(False, f"transport: {exc.__class__.__name__}")

    if res.status_code >= 400:
        # Twilio's error body names the cause — 21608 trial-number, 21211 bad
        # number, 30034 unregistered A2P. Logged verbatim; the code alone is
        # unguessable at 3am.
        log.error("twilio sms rejected: %s %s", res.status_code, res.text)
        return Delivered(False, f"twilio_{res.status_code}")

    return Delivered(True)


async def send_email(settings: Settings, to: str, subject: str, text: str) -> Delivered:
    if not settings.email_configured:
        log.error("Email not configured — set RESEND_API_KEY / RESEND_FROM")
        return Delivered(False, "email_not_configured")

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(
                RESEND_URL,
                headers={"authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": settings.resend_from,
                    "to": [to],
                    "subject": subject,
                    "text": text,
                },
            )
    except httpx.HTTPError as exc:
        log.exception("resend transport failure")
        return Delivered(False, f"transport: {exc.__class__.__name__}")

    if res.status_code >= 400:
        log.error("resend rejected: %s %s", res.status_code, res.text)
        return Delivered(False, f"resend_{res.status_code}")

    return Delivered(True)


# ------------------------------------------------------------------ OTP copy

# Kept here beside the sender: the wording is carrier-visible and, on the SMS
# leg, length-sensitive. Named so it never reads as a marketing message.


def otp_sms_body(code: str, ttl_min: int) -> str:
    return f"{code} is your Kinvox verification code. It expires in {ttl_min} minutes."


def otp_email_subject(code: str) -> str:
    return f"{code} is your Kinvox verification code"


def otp_email_text(code: str, ttl_min: int) -> str:
    return (
        f"Your Kinvox verification code is {code}.\n\n"
        f"It expires in {ttl_min} minutes. If you did not ask for it, ignore this email."
    )
