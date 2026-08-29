"""spec: caregiver auth — screens 1a / 2a.

Four endpoints. The modules under `api/auth/` hold the rules; this file is only
HTTP: parse, delegate, shape the answer.

Envelope: `{ok:true, ...}` / `{ok:false, error}` at HTTP 200 for business
outcomes, per TRD §5.1 — the app's client.ts already inverts that into a thrown
ApiError with a human message. The one exception is an absent or dead session,
which is a real 401; see api/auth/deps.py for why.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, field_validator

from api import db
from api.auth import otp, session as sess
from api.auth.deps import CaregiverDep, IpDep, SettingsDep
from api.auth.otp import Channel, VerifyResult
from api.services import delivery

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Mirrors app/src/setup/store.ts — toE164() and isEmail(). The client validates
# to keep the UI honest; the server validates because the client is not trusted.
# India only for now: +91 followed by a 10-digit mobile (6–9 leading digit).
E164 = r"^\+91[6-9]\d{9}$"
EMAIL = r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"


class StartBody(BaseModel):
    channel: Channel
    destination: str

    @field_validator("destination")
    @classmethod
    def _trim(cls, v: str) -> str:
        return v.strip()


class VerifyBody(StartBody):
    code: str


def _well_formed(channel: Channel, destination: str) -> bool:
    import re

    pattern = EMAIL if channel is Channel.email else E164
    return bool(re.match(pattern, destination))


@router.post("/otp/start")
async def otp_start(body: StartBody, request: Request, settings: SettingsDep, ip: IpDep):
    """Issue a code and send it.

    Answers the same shape no matter what: malformed destination, unknown
    number, rate-limited, or genuinely sent. Any observable difference between
    "this number has an account" and "it does not" is an enumeration oracle, and
    the caregiver's phone number is the whole identity here.
    """
    destination = otp.normalise(body.channel, body.destination)
    generic = {"ok": True, "resend_after_s": settings.otp_resend_cooldown_s}

    if not _well_formed(body.channel, destination):
        return generic

    async with db.transaction() as conn:
        decision = await otp.prepare_send(conn, settings, body.channel, destination, ip)

    if not decision.send or decision.code is None:
        # Cooldown, hourly cap, or a bypass number that needs no carrier hop.
        return {"ok": True, "resend_after_s": decision.resend_after_s}

    if body.channel is Channel.sms:
        # `sms` names the phone channel, not the transport. Delivery walks the
        # TRD §9 ladder — WhatsApp, then SMS — because WhatsApp reaches Indian
        # numbers without DLT registration and SMS does not.
        sent = await delivery.deliver_phone_otp(
            settings, destination, decision.code, settings.otp_ttl_min
        )
    else:
        sent = await delivery.send_email(
            settings,
            destination,
            delivery.otp_email_subject(decision.code),
            delivery.otp_email_text(decision.code, settings.otp_ttl_min),
        )

    if not sent.ok:
        # Two different failures, and they must not look alike to the caller.
        #
        # A config fault (no Twilio key, dead socket) is ours. The caregiver can
        # do nothing about it, and echoing it back would make the response vary
        # with our internal state — exactly the probe this endpoint is shaped to
        # deny. It goes to the operator's log and the caller gets the generic
        # answer, same as every other outcome.
        #
        # A destination rejection is theirs: a typo, a landline, a disconnected
        # number. Telling them beats a spinner over an inbox that will never
        # fill (TRD §9: never silent).
        log.error("otp send failed channel=%s detail=%s", body.channel.value, sent.detail)
        if sent.config_error:
            return generic
        return {"ok": False, "error": "delivery_failed"}

    return {"ok": True, "resend_after_s": decision.resend_after_s}


@router.post("/otp/verify")
async def otp_verify(
    body: VerifyBody, request: Request, response: Response, settings: SettingsDep
):
    """Check the code; on success create or find the caregiver and open a session.

    SMS verifies identity and issues the cookie. Email runs the same path but
    attaches to whoever is already signed in — the address is a property of an
    existing caregiver, not a second way to become one.
    """
    destination = otp.normalise(body.channel, body.destination)

    async with db.transaction() as conn:
        # Authorise BEFORE touching the code. An email verify with no session can
        # never succeed, so checking the code first only gave an anonymous caller
        # a way to spend someone else's attempts — five requests and the victim's
        # outstanding code is dead. Order is the whole fix.
        caregiver = None
        if body.channel is Channel.email:
            existing = sess.token_from(request, settings)
            caregiver = await sess.resolve(conn, existing) if existing else None
            if caregiver is None:
                # Verifying an email without a session would create a second,
                # phoneless identity. Steps 3-4 always run after step 2.
                return {"ok": False, "error": "unauthorized"}

        result = await otp.verify_code(conn, settings, body.channel, destination, body.code)
        if result is not VerifyResult.ok:
            return {"ok": False, "error": result.value}

        if body.channel is Channel.sms:
            row = await conn.fetchrow(
                """
                INSERT INTO caregivers (phone_e164, phone_verified_at)
                     VALUES ($1, now())
                ON CONFLICT (phone_e164)
                  DO UPDATE SET phone_verified_at = now()
                  RETURNING id, name, phone_e164, email, relationship,
                            phone_verified_at, email_verified_at,
                            (xmax = 0) AS inserted
                """,
                destination,
            )
            # xmax = 0 distinguishes an INSERT from an ON CONFLICT UPDATE, which
            # is what tells the app to run onboarding rather than go to /home.
            is_new = bool(row["inserted"])
            token = await sess.issue(
                conn, settings, row["id"], request.headers.get("user-agent")
            )
            sess.set_cookie(response, settings, token)
        else:
            row = await conn.fetchrow(
                """
                UPDATE caregivers SET email = $2, email_verified_at = now()
                 WHERE id = $1
             RETURNING id, name, phone_e164, email, relationship,
                       phone_verified_at, email_verified_at
                """,
                caregiver.id,
                destination,
            )
            is_new = False

    return {
        "ok": True,
        "is_new": is_new,
        "caregiver": sess.Caregiver(
            id=str(row["id"]),
            name=row["name"],
            phone_e164=row["phone_e164"],
            email=row["email"],
            relationship=row["relationship"],
            phone_verified_at=row["phone_verified_at"],
            email_verified_at=row["email_verified_at"],
        ).as_json(),
    }


@router.get("/me")
async def me(caregiver: CaregiverDep):
    """401 when there is no session — the route guard reads the status, not the body."""
    return {"ok": True, "caregiver": caregiver.as_json()}


@router.post("/logout")
async def logout(request: Request, response: Response, settings: SettingsDep):
    token = sess.token_from(request, settings)
    if token:
        async with db.connection() as conn:
            await sess.revoke(conn, token)
    sess.clear_cookie(response, settings)
    return {"ok": True}
