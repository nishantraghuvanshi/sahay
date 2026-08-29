"""spec: TRD §15 · settings loaded once, validated at import.

Every secret is required with no default. A missing `OTP_PEPPER` that silently
defaults to `""` would still hash, still compare, still let people log in — and
every OTP in the database would be forgeable by anyone who knows the algorithm.
Failing at boot is the only safe reading of an absent secret.
"""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",  # .env carries the voice/telephony lanes' vars too
    )

    # ---------------------------------------------------------------- core
    database_url: str
    care_api_token: str = ""  # agent↔API shared secret (TRD §15); unused by auth
    public_base_url: str = "http://localhost:8000"
    app_origin: str = "http://localhost:5173"

    # ------------------------------------------------------------- session
    session_cookie_name: str = "kv_session"
    session_ttl_days: int = 30
    # Off in local dev (http://localhost has no TLS, and a Secure cookie is
    # simply dropped there). MUST be true anywhere with a real domain.
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # ----------------------------------------------------------------- otp
    otp_pepper: str
    otp_ttl_min: int = 10
    otp_max_attempts: int = 5
    otp_resend_cooldown_s: int = 30
    otp_max_per_destination_hour: int = 5
    otp_max_per_ip_hour: int = 20

    # ------------------------------------------------------------ delivery
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_number: str = ""
    resend_api_key: str = ""
    resend_from: str = ""

    # Demo fallback for un-DLT-registered Indian A2P SMS: these numbers get a
    # fixed code and no carrier hop. Every other step — hashing, expiry, attempt
    # counting, session issue — runs exactly as in production.
    dev_otp_bypass_numbers: str = ""
    dev_otp_bypass_code: str = "424242"

    @field_validator("otp_pepper")
    @classmethod
    def _pepper_is_real(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError(
                "OTP_PEPPER must be at least 16 chars. Generate one with: "
                "python -c 'import secrets; print(secrets.token_urlsafe(32))'"
            )
        return v

    @property
    def bypass_numbers(self) -> set[str]:
        return {n.strip() for n in self.dev_otp_bypass_numbers.split(",") if n.strip()}

    @property
    def sms_configured(self) -> bool:
        return bool(self.twilio_account_sid and self.twilio_auth_token and self.twilio_number)

    @property
    def email_configured(self) -> bool:
        return bool(self.resend_api_key and self.resend_from)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
