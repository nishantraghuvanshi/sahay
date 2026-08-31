"""spec: caregiver auth — screens 1a / 2a.

The modules under `api/auth/` hold the rules; this file is only HTTP: parse,
delegate, shape the answer.

Envelope: `{ok:true, ...}` / `{ok:false, error}` at HTTP 200 for business
outcomes, per TRD §5.1 — the app's client.ts already inverts that into a thrown
ApiError with a human message. The one exception is an absent or dead session,
which is a real 401; see api/auth/deps.py for why.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from datetime import UTC, datetime

import logging

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, field_validator

from api import db
from api.auth import otp, password as pw, session as sess
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
            # Upstream used `(xmax = 0) AS inserted` to tell an INSERT from an
            # ON CONFLICT UPDATE — that is a Postgres system column and has no
            # SQLite equivalent, so the existence check is explicit instead.
            # Same answer, and it is the answer that decides whether the app
            # runs onboarding or goes straight to /home.
            now_iso = datetime.now(UTC).isoformat()
            existing_id = await conn.fetchval(
                "SELECT id FROM caregivers WHERE phone_e164 = $1", destination
            )
            is_new = existing_id is None
            if is_new:
                await conn.execute(
                    "INSERT INTO caregivers (id, phone_e164, phone_verified_at, created_at) "
                    "VALUES ($1, $2, $3, $4)",
                    str(uuid.uuid4()),
                    destination,
                    now_iso,
                    now_iso,
                )
            else:
                await conn.execute(
                    "UPDATE caregivers SET phone_verified_at = $2 WHERE id = $1",
                    existing_id,
                    now_iso,
                )
            row = await conn.fetchrow(
                "SELECT id, name, phone_e164, email, relationship, "
                "phone_verified_at, email_verified_at FROM caregivers "
                "WHERE phone_e164 = $1",
                destination,
            )
            token = await sess.issue(
                conn, settings, row["id"], request.headers.get("user-agent")
            )
            sess.set_cookie(response, settings, token)
        else:
            row = await conn.fetchrow(
                """
                UPDATE caregivers SET email = $2, email_verified_at = $3
                 WHERE id = $1
             RETURNING id, name, phone_e164, email, relationship,
                       phone_verified_at, email_verified_at
                """,
                caregiver.id,
                destination,
                datetime.now(UTC).isoformat(),
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


class CompleteSignupBody(BaseModel):
    """Step 5 — the caregiver's own details.

    Everything before this proves the phone and the email belong to them. This is
    where they say who they are: `caregivers.name` had no other source, so the
    Settings and Care record screens were reading a name that only ever existed
    in the mock fixture.
    """

    name: str
    password: str
    relationship: str | None = None


class LoginBody(BaseModel):
    """`identifier` is a phone in E.164 or an email — whichever they signed up with."""

    identifier: str
    password: str


@router.post("/complete-signup")
async def complete_signup(body: CompleteSignupBody, caregiver: CaregiverDep):
    """Name + password, once the OTPs have proved both channels.

    Session-required by design: a password can only ever be set by someone who
    has already proved they hold the phone. That is what stops it becoming a way
    to claim an account you do not own.
    """
    name = body.name.strip()
    if not name:
        return {"ok": False, "error": "name_required"}

    problem = pw.problem_with(body.password)
    if problem:
        return {"ok": False, "error": problem}

    digest, salt = pw.hash_password(body.password)

    async with db.transaction() as conn:
        row = await conn.fetchrow(
            """
            UPDATE caregivers
               SET name = $2,
                   relationship = COALESCE(NULLIF($3, ''), relationship),
                   password_hash = $4, password_salt = $5, password_set_at = $6,
                   failed_logins = 0, locked_until = NULL
             WHERE id = $1
         RETURNING id, name, phone_e164, email, relationship,
                   phone_verified_at, email_verified_at
            """,
            caregiver.id,
            name,
            (body.relationship or "").strip(),
            digest,
            salt,
            datetime.now(UTC).isoformat(),
        )

    return {"ok": True, "caregiver": _as_json(row)}


class CheckBody(BaseModel):
    """One phone-or-email box, same as the login field."""

    identifier: str


# A caller who can ask "does this account exist" 10,000 times has a customer
# list. `/auth/otp/start` is deliberately blind for exactly that reason, so this
# endpoint — which is not blind — carries the cost the blindness used to.
#
# In-process and per-IP: one API process, and a restart clearing the window is
# an acceptable loss for a throttle whose job is to make bulk enumeration
# tedious rather than to be an audit record. A dict of deques of floats.
CHECK_MAX_PER_IP_HOUR = 40
_check_hits: dict[str, deque[float]] = defaultdict(deque)


def _check_allowed(ip: str | None) -> bool:
    if ip is None:
        return True
    hits = _check_hits[ip]
    cutoff = time.monotonic() - 3600
    while hits and hits[0] < cutoff:
        hits.popleft()
    if len(hits) >= CHECK_MAX_PER_IP_HOUR:
        return False
    hits.append(time.monotonic())
    return True


@router.post("/check")
async def check(body: CheckBody, ip: IpDep):
    """Does this phone or email already have an account?

    This is an enumeration oracle, and it is one on purpose. The rest of auth
    goes out of its way to deny it: `/auth/otp/start` answers identically for a
    known and an unknown number, and `/auth/login` calls every failure
    `invalid_credentials`. That protects a caregiver's phone number from being
    confirmed as ours by a stranger — but it also means the two dead ends people
    actually hit have no way out.

    A new caregiver typing a password on `/login` gets "that does not match",
    which is not true and not actionable — they have nothing to match with. An
    existing caregiver on `/signup` gets an SMS they did not need, and only
    finds out four steps later. Both send them to the other page with the
    identifier already in hand, which is what this endpoint is for.

    `has_password` separates the two accounts that both "exist": one that
    finished step 5 and can log in, and one that verified a phone and stopped —
    the second must go back to signup to finish, not to a login form its owner
    can never satisfy.

    Throttled per IP. Answers `unknown` rather than a guess when over the limit,
    so the caller falls back to the vague-but-safe wording instead of asserting
    something it does not know.
    """
    if not _check_allowed(ip):
        return {"ok": True, "unknown": True, "exists": False, "has_password": False}

    identifier = otp.normalise_identifier(body.identifier)
    if not identifier:
        return {"ok": True, "unknown": True, "exists": False, "has_password": False}

    async with db.connection() as conn:
        row = await conn.fetchrow(
            "SELECT password_hash FROM caregivers "
            " WHERE phone_e164 = $1 OR lower(email) = lower($1)",
            identifier,
        )

    return {
        "ok": True,
        "unknown": False,
        "exists": row is not None,
        "has_password": row is not None and row["password_hash"] is not None,
    }


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response, settings: SettingsDep):
    """Returning caregiver: identifier + password.

    Three distinct failures, deliberately: `no_account` (nobody here),
    `signup_incomplete` (phone verified, never set a password) and
    `invalid_credentials` (right account, wrong password). Only the third is
    about the password, and only the third should say so.

    This does leak whether an account exists. That was a considered trade, made
    once for `/auth/check` and applied here for consistency — see the long note
    on that endpoint. A single vague answer meant a first-time caregiver was
    told their password was wrong when they had never set one, and had no way to
    discover that signing up was the missing step.
    """
    # Normalised the same way `/auth/otp/start` normalises a destination. It was
    # a bare .strip(), and the two halves of auth disagreeing about how a phone
    # number is spelled meant a caregiver could sign up successfully and then be
    # told their password did not match — typing the number exactly the way the
    # login field's own placeholder shows it ("+91 98765 43210") found no row.
    identifier = otp.normalise_identifier(body.identifier)
    invalid = {"ok": False, "error": "invalid_credentials"}

    async with db.transaction() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, phone_e164, email, relationship,
                   phone_verified_at, email_verified_at,
                   password_hash, password_salt, failed_logins, locked_until
              FROM caregivers
             WHERE phone_e164 = $1 OR lower(email) = lower($1)
            """,
            identifier,
        )
        if row is None:
            # No such caregiver. `/auth/check` will say the same thing to anyone
            # who asks it directly, so hiding it here buys nothing and costs a
            # new caregiver the one instruction they need: sign up first.
            return {"ok": False, "error": "no_account"}

        if row["password_hash"] is None:
            # The phone was verified and signup stopped before step 5. There is
            # no password to be wrong about; "invalid_credentials" sent them
            # round the same loop forever.
            return {"ok": False, "error": "signup_incomplete"}

        if pw.is_locked(row["locked_until"]):
            return {"ok": False, "error": "account_locked"}

        if not pw.verify_password(body.password, row["password_hash"], row["password_salt"]):
            failed = row["failed_logins"] + 1
            await conn.execute(
                "UPDATE caregivers SET failed_logins = $2, locked_until = $3 WHERE id = $1",
                row["id"],
                failed,
                pw.lockout_until() if failed >= pw.MAX_FAILED_LOGINS else None,
            )
            return invalid

        await conn.execute(
            "UPDATE caregivers SET failed_logins = 0, locked_until = NULL WHERE id = $1",
            row["id"],
        )
        token = await sess.issue(conn, settings, row["id"], request.headers.get("user-agent"))
        sess.set_cookie(response, settings, token)

    return {"ok": True, "caregiver": _as_json(row)}


def _as_json(row) -> dict:
    return sess.Caregiver(
        id=str(row["id"]),
        name=row["name"],
        phone_e164=row["phone_e164"],
        email=row["email"],
        relationship=row["relationship"],
        phone_verified_at=row["phone_verified_at"],
        email_verified_at=row["email_verified_at"],
    ).as_json()


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
