"""FastAPI dependencies for authenticated routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from api import db
from api.auth import session as sess
from api.auth.session import Caregiver
from api.config import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]


async def current_caregiver(request: Request, settings: SettingsDep) -> Caregiver:
    """Resolve the session cookie, or 401.

    A real 401 rather than the `{ok:false}` envelope of TRD §5.1. That
    convention exists because "a non-2xx makes the agent stall and the parent
    hears silence" (TRD §5.1) — the reasoning is about the voice agent on a
    phone call, not a browser. The route guard has to tell "not signed in" from
    "this endpoint broke", and only a status code carries that distinction.
    Business failures below (wrong code, rate limited) keep the envelope.
    """
    token = sess.token_from(request, settings)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthorized")

    async with db.connection() as conn:
        caregiver = await sess.resolve(conn, token)
        if caregiver is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthorized")
        await sess.slide_if_stale(conn, settings, token)

    return caregiver


CaregiverDep = Annotated[Caregiver, Depends(current_caregiver)]


def client_ip(request: Request) -> str | None:
    """Rate-limit key. Behind a proxy the socket peer is the proxy, so prefer the
    first X-Forwarded-For hop — trusted only because the API is not meant to be
    reachable except through one."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


IpDep = Annotated[str | None, Depends(client_ip)]
