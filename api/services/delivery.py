"""spec: TRD §9

WhatsApp -> SMS -> voice call on P1. Failed send recorded, never silent.

Only the SMS and email legs exist so far — they are what caregiver auth needs.
The escalation ladder inherits `send_sms` when Lane B builds it.

Every sender returns a `Delivered` rather than raising: a failed OTP send must
become a message the caregiver can act on, not a 500. "Never silent" cuts both
ways — the failure is returned and logged, not swallowed.
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

import httpx

from api.config import Settings

log = logging.getLogger(__name__)

TWILIO_SMS_URL = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
WHATSAPP_URL = "https://graph.facebook.com/v21.0/{phone_id}/messages"
RESEND_URL = "https://api.resend.com/emails"
TIMEOUT_S = 10.0


@dataclass(frozen=True)
class Delivered:
    ok: bool
    detail: str = ""
    # True when WE are misconfigured, as opposed to the destination being
    # refused. The caller must not echo a config fault back to the browser: the
    # caregiver cannot act on it, and a response that varies with our internal
    # state is one more thing an attacker can probe. Log it, answer generically.
    config_error: bool = False


def _smtp_send_blocking(settings: Settings, to: str, subject: str, text: str) -> None:
    """Blocking SMTP, run off the event loop by the caller."""
    msg = EmailMessage()
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)

    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=TIMEOUT_S) as server:
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        return

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=TIMEOUT_S) as server:
        server.starttls()
        server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(msg)


async def _send_email_smtp(settings: Settings, to: str, subject: str, text: str) -> Delivered:
    """smtplib is synchronous, so it goes to a worker thread — blocking the event
    loop here would stall every other request for the length of the SMTP
    handshake, which is the slowest thing this API does."""
    try:
        await asyncio.to_thread(_smtp_send_blocking, settings, to, subject, text)
    except smtplib.SMTPAuthenticationError:
        # Gmail rejects a normal account password outright; this needs an app
        # password, which in turn needs 2-Step Verification on the account.
        log.exception("smtp auth rejected — for Gmail use an app password, not the account password")
        return Delivered(False, "smtp_auth", config_error=True)
    except smtplib.SMTPRecipientsRefused:
        log.exception("smtp recipient refused: %s", to)
        return Delivered(False, "smtp_recipient_refused")
    except (smtplib.SMTPException, OSError) as exc:
        log.exception("smtp send failed")
        return Delivered(False, f"smtp: {exc.__class__.__name__}", config_error=True)

    return Delivered(True)


async def send_email(settings: Settings, to: str, subject: str, text: str) -> Delivered:
    """SMTP if configured, else Resend.

    SMTP wins because Resend's shared `resend.dev` sender only reaches the
    account holder. A caregiver entering their own address has to actually
    receive the code, and only a real sender identity does that.
    """
    if settings.smtp_configured:
        return await _send_email_smtp(settings, to, subject, text)
    return await _send_email_resend(settings, to, subject, text)


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


async def send_sms(settings: Settings, to_e164: str, body: str) -> Delivered:
    if not settings.sms_configured:
        log.error("SMS not configured — set TWILIO_ACCOUNT_SID / AUTH_TOKEN / NUMBER")
        return Delivered(False, "sms_not_configured", config_error=True)

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(
                TWILIO_SMS_URL.format(sid=settings.twilio_account_sid),
                auth=(settings.twilio_account_sid, settings.twilio_auth_token),
                data={"To": to_e164, "From": settings.twilio_number, "Body": body},
            )
    except httpx.HTTPError as exc:
        log.exception("twilio sms transport failure")
        return Delivered(False, f"transport: {exc.__class__.__name__}", config_error=True)

    if res.status_code >= 400:
        # Twilio's error body names the cause — 21608 trial-number, 21211 bad
        # number, 30034 unregistered A2P. Logged verbatim; the code alone is
        # unguessable at 3am.
        log.error("twilio sms rejected: %s %s", res.status_code, res.text)
        return Delivered(False, f"twilio_{res.status_code}")

    return Delivered(True)


async def send_whatsapp_otp(settings: Settings, to_e164: str, code: str) -> Delivered:
    """Send the code over WhatsApp Cloud API.

    Why this exists: India requires DLT registration for A2P SMS, which takes
    days and freezes the message text once approved. WhatsApp is not SMS, so
    none of that applies — this is the only route to a real phone OTP that can
    go live the same day.

    Must be an *authentication* template. Meta will not deliver a code through a
    marketing or utility one, and an unapproved name fails with 132001.
    """
    if not settings.whatsapp_configured:
        log.error("WhatsApp not configured — set WHATSAPP_TOKEN / WHATSAPP_PHONE_ID")
        return Delivered(False, "whatsapp_not_configured", config_error=True)

    components: list[dict] = [
        {"type": "body", "parameters": [{"type": "text", "text": code}]}
    ]
    if settings.whatsapp_otp_has_button:
        # The copy-code button is a separate component carrying the same code.
        # Omitting it on a template that has one fails with 132000.
        components.append(
            {
                "type": "button",
                "sub_type": "url",
                "index": "0",
                "parameters": [{"type": "text", "text": code}],
            }
        )

    payload = {
        "messaging_product": "whatsapp",
        # Meta wants bare digits, no leading '+'.
        "to": to_e164.lstrip("+"),
        "type": "template",
        "template": {
            "name": settings.whatsapp_otp_template,
            "language": {"code": settings.whatsapp_otp_lang},
            "components": components,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(
                WHATSAPP_URL.format(phone_id=settings.whatsapp_phone_id),
                headers={"authorization": f"Bearer {settings.whatsapp_token}"},
                json=payload,
            )
    except httpx.HTTPError as exc:
        log.exception("whatsapp transport failure")
        return Delivered(False, f"transport: {exc.__class__.__name__}", config_error=True)

    if res.status_code >= 400:
        # Meta's body names the cause: 132000 parameter-count mismatch (check
        # whatsapp_otp_has_button), 132001 template not found, 131030 recipient
        # not on the allow-list while the number is still in test mode.
        log.error("whatsapp rejected: %s %s", res.status_code, res.text)
        return Delivered(False, f"whatsapp_{res.status_code}")

    return Delivered(True)


async def deliver_phone_otp(settings: Settings, to_e164: str, code: str, ttl_min: int) -> Delivered:
    """WhatsApp first, SMS second — the same ladder TRD §9 gives escalation.

    WhatsApp leads because it reaches Indian numbers today; SMS catches the
    caregiver who does not use WhatsApp, once DLT clears. If neither is
    configured the result is a config error, which the caller turns into a
    generic response rather than telling the world what we are missing.
    """
    if settings.whatsapp_configured:
        sent = await send_whatsapp_otp(settings, to_e164, code)
        if sent.ok:
            return sent
        log.warning("whatsapp otp failed (%s) — falling back to sms", sent.detail)

    return await send_sms(settings, to_e164, otp_sms_body(code, ttl_min))


async def _send_email_resend(settings: Settings, to: str, subject: str, text: str) -> Delivered:
    if not settings.email_configured:
        log.error("Email not configured — set SMTP_HOST/USER/PASSWORD, or RESEND_API_KEY/RESEND_FROM")
        return Delivered(False, "email_not_configured", config_error=True)

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
        return Delivered(False, f"transport: {exc.__class__.__name__}", config_error=True)

    if res.status_code >= 400:
        log.error("resend rejected: %s %s", res.status_code, res.text)
        return Delivered(False, f"resend_{res.status_code}")

    return Delivered(True)
