"""Opaque sessions and the cookie that carries them.

Opaque, not JWT: a session must die the moment it is revoked, and a signed token
that verifies without a database read cannot be revoked at all. Nothing here
needs stateless verification — the API touches the database on every request anyway.

The raw token exists only in the caregiver's cookie. The database holds sha256
of it, so a dump of `auth_sessions` yields no usable login.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response

from api import db
from api.config import Settings

TOKEN_BYTES = 32  # 256 bits, URL-safe — same order as the handoff token (TRD §11)

# Below this much remaining life, a request slides the expiry forward. Rewriting
# the row on every single request would make a read-heavy screen a write load.
SLIDE_WHEN_REMAINING = timedelta(days=7)


@dataclass(frozen=True)
class Caregiver:
    id: str
    name: str
    phone_e164: str
    email: str | None
    relationship: str | None
    phone_verified_at: datetime | None
    email_verified_at: datetime | None

    def as_json(self) -> dict:
        return {
            "id": str(self.id),
            "name": self.name,
            "phone_e164": self.phone_e164,
            "email": self.email,
            "relationship": self.relationship,
            "phone_verified": self.phone_verified_at is not None,
            "email_verified": self.email_verified_at is not None,
        }


def _hash(token: str) -> bytes:
    # Plain sha256, not HMAC: the token is 256 bits of CSPRNG output, so there is
    # no low-entropy input for a pepper to protect. Speed is a feature here —
    # this runs on every authenticated request.
    return hashlib.sha256(token.encode()).digest()


async def issue(
    conn,
    settings: Settings,
    caregiver_id: str,
    user_agent: str | None,
) -> str:
    token = secrets.token_urlsafe(TOKEN_BYTES)
    now = datetime.now(UTC)
    # id, created_at and last_seen_at are supplied rather than defaulted: the
    # SQLite schema has no gen_random_uuid() or now(), and a TEXT primary key
    # accepts NULL silently — three tables in this repo were found holding NULL
    # ids exactly that way.
    await conn.execute(
        "INSERT INTO auth_sessions "
        "(id, caregiver_id, token_hash, expires_at, last_seen_at, user_agent, created_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        str(uuid.uuid4()),
        caregiver_id,
        _hash(token),
        (now + timedelta(days=settings.session_ttl_days)).isoformat(),
        now.isoformat(),
        (user_agent or "")[:500],
        now.isoformat(),
    )
    return token


async def resolve(conn, token: str) -> Caregiver | None:
    row = await conn.fetchrow(
        """
        SELECT s.id AS session_id, s.expires_at,
               c.id, c.name, c.phone_e164, c.email, c.relationship,
               c.phone_verified_at, c.email_verified_at
          FROM auth_sessions s
          JOIN caregivers c ON c.id = s.caregiver_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > $2
        """,
        _hash(token),
        datetime.now(UTC).isoformat(),
    )
    if row is None:
        return None

    await conn.execute(
        "UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1",
        row["session_id"],
        datetime.now(UTC).isoformat(),
    )
    return Caregiver(
        id=str(row["id"]),
        name=row["name"],
        phone_e164=row["phone_e164"],
        email=row["email"],
        relationship=row["relationship"],
        phone_verified_at=row["phone_verified_at"],
        email_verified_at=row["email_verified_at"],
    )


async def slide_if_stale(conn, settings: Settings, token: str) -> None:
    now = datetime.now(UTC)
    await conn.execute(
        "UPDATE auth_sessions SET expires_at = $2 "
        "WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at < $3",
        _hash(token),
        (now + timedelta(days=settings.session_ttl_days)).isoformat(),
        (now + SLIDE_WHEN_REMAINING).isoformat(),
    )


async def revoke(conn, token: str) -> None:
    await conn.execute(
        "UPDATE auth_sessions SET revoked_at = $2 "
        "WHERE token_hash = $1 AND revoked_at IS NULL",
        _hash(token),
        datetime.now(UTC).isoformat(),
    )


# --------------------------------------------------------------------- cookie


def set_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_ttl_days * 24 * 3600,
        httponly=True,  # no page script can read it, so an XSS cannot exfiltrate it
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def clear_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
    )


def token_from(request: Request, settings: Settings) -> str | None:
    return request.cookies.get(settings.session_cookie_name)
