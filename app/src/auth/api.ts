import { authApi } from '../api/client'

/** Mirrors api/auth/session.py → Caregiver.as_json(). */
export interface Caregiver {
  id: string
  name: string
  phone_e164: string
  email: string | null
  relationship: string | null
  phone_verified: boolean
  email_verified: boolean
}

export type Channel = 'sms' | 'email'

interface StartResponse {
  /** Server-owned cooldown. The UI counts down from this rather than its own
   *  constant, so the button cannot re-enable before the server will accept. */
  resend_after_s: number
}

interface VerifyResponse {
  caregiver: Caregiver
  /** True when this phone had no caregiver row until now — onboarding, not /home. */
  is_new: boolean
}

export const auth = {
  start: (channel: Channel, destination: string) =>
    authApi.post<StartResponse>('/auth/otp/start', { channel, destination }),

  verify: (channel: Channel, destination: string, code: string) =>
    authApi.post<VerifyResponse>('/auth/otp/verify', { channel, destination, code }),

  me: () => authApi.get<{ caregiver: Caregiver }>('/auth/me'),

  logout: () => authApi.post<Record<string, never>>('/auth/logout', {}),
}
