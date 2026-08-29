"""spec: TRD §5.1

FastAPI app. All tools return HTTP 200; errors are {ok:false} (NFR-6).

Two surfaces live here, and they authenticate differently:

  /auth/*, /app/*   the caregiver app. Session cookie. A dead session is a real
                    401, because a browser route guard has to tell "signed out"
                    from "broken" (see api/auth/deps.py).
  the seven tools   the voice agent. Bearer CARE_API_TOKEN, always HTTP 200 —
                    "a non-2xx makes the agent stall and the parent hears
                    silence" (TRD §5.1). Not yet built; Lane B owns them.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import db
from api.auth.routes import router as auth_router
from api.caregiver.routes import router as caregiver_router
from api.config import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()  # raises here, not on the first request, if a secret is missing
    await db.open_pool()
    logging.getLogger(__name__).info("care api up · app origin %s", settings.app_origin)
    try:
        yield
    finally:
        await db.close_pool()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Kinvox Care API", lifespan=lifespan)

    # Exact origins only. allow_credentials with a wildcard origin is rejected by
    # every browser, and the session cookie depends on credentials being sent.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.app_origin.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["content-type"],
    )

    app.include_router(auth_router)
    app.include_router(caregiver_router)

    @app.get("/health")
    async def health():
        async with db.connection() as conn:
            await conn.fetchval("SELECT 1")
        return {"ok": True}

    return app


app = create_app()
