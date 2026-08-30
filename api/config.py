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
    # No longer a connection string: this API runs on SQLite and db.py reads
    # KINVOX_DB for the file path. Kept, with a default, because it arrived with
    # the auth lane and a required field with no default makes every settings
    # load fail at import — including for the routes that never touch it.
    database_url: str = ""
    care_api_token: str = ""  # agent↔API shared secret (TRD §15); unused by auth

    # ------------------------------------------------------- demo call
    # The voice agent's own HTTP service. The API never speaks to ElevenLabs
    # directly: the agent owns that integration, the prompt, and the caregiver's
    # dose schedule, so a demo that bypassed it would be demonstrating something
    # other than what the phone call runs.
    agent_base_url: str = "http://localhost:3001"
    # Sent as x-api-key when the agent has API_KEY set. Empty in local dev,
    # where the agent's own auth middleware is disabled.
    agent_api_key: str = ""
    demo_call_timeout_s: float = 120.0
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

    # SMTP. Preferred over Resend when set, because Resend's shared sandbox
    # domain only delivers to the account holder — a caregiver typing their own
    # address would never get the code. A Gmail app password reaches anyone.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""

    # WhatsApp Cloud API. The way to real phone OTP in India today: it is not
    # SMS, so TRAI's DLT registration does not apply and there is no multi-day
    # wait for a sender header. TRD §9 already puts WhatsApp first on the
    # escalation ladder, so this is the same credential that lane needs.
    whatsapp_token: str = ""
    whatsapp_phone_id: str = ""
    whatsapp_otp_template: str = "otp_verification"
    whatsapp_otp_lang: str = "en"
    # Meta's authentication templates usually carry a copy-code button, and the
    # button needs its own component or the send fails on a parameter-count
    # mismatch. Flip this to match whatever template you actually got approved.
    whatsapp_otp_has_button: bool = False

    # Demo fallback for un-DLT-registered Indian A2P SMS: these numbers get a
    # fixed code and no carrier hop. Every other step — hashing, expiry, attempt
    # counting, session issue — runs exactly as in production.
    dev_otp_bypass_numbers: str = ""
    # Same escape hatch for email. Without a Resend key nothing can be
    # delivered, and steps 3-4 gate the Continue button — so with neither key
    # nor bypass, signup is not completable at all.
    dev_otp_bypass_emails: str = ""
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
    def bypass_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.dev_otp_bypass_emails.split(",") if e.strip()}

    @property
    def sms_configured(self) -> bool:
        return bool(self.twilio_account_sid and self.twilio_auth_token and self.twilio_number)

    @property
    def whatsapp_configured(self) -> bool:
        return bool(self.whatsapp_token and self.whatsapp_phone_id)

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    @property
    def email_configured(self) -> bool:
        return self.smtp_configured or bool(self.resend_api_key and self.resend_from)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
