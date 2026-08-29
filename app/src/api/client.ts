import { API_BASE, AUTH_BASE } from '../config'

/**
 * The Care API answers HTTP 200 even on failure — errors are data, `{ok:false,error}`
 * (TRD §5.1, NFR-6). That is right for the voice agent, which must never hear silence,
 * and wrong for a UI: an error rendered as data is a screen quietly showing nothing.
 * So the wrapper inverts it — `{ok:false}` becomes a thrown ApiError.
 *
 * The one status code that stays a status code is 401. A route guard has to tell
 * "signed out" from "this endpoint broke", and only the transport carries that.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Reads race a call in progress, so they fail fast (TRD §5.1's 3s hard timeout). */
const READ_TIMEOUT_MS = 3000

/**
 * Auth gets far longer: `/auth/otp/start` waits on Twilio or Resend, whose own
 * budget is 10s. Aborting at 3s would abandon a code that is already stored and
 * about to be delivered — the caregiver would get the SMS *and* an error.
 */
const AUTH_TIMEOUT_MS = 15000

type Envelope<T> = ({ ok: true } & T) | { ok: false; error: string }

/** Called on any 401 so the session cache can drop and the guard can redirect. */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

async function request<T>(
  base: string,
  path: string,
  init?: RequestInit,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      // The session is an httpOnly cookie: no script can read it, so it has to
      // ride along on the request itself.
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('The Care API did not answer in time.', 'timeout')
    }
    throw new ApiError('Cannot reach the Care API.', 'unreachable')
  }
  clearTimeout(timer)

  if (res.status === 401) {
    onUnauthorized?.()
    throw new ApiError(humanise('unauthorized'), 'unauthorized', 401)
  }

  if (!res.ok) {
    throw new ApiError(`The Care API returned ${res.status}.`, 'http_error', res.status)
  }

  const body = (await res.json()) as Envelope<T>
  if (body && typeof body === 'object' && 'ok' in body && body.ok === false) {
    throw new ApiError(humanise(body.error), body.error)
  }
  return body as T
}

/** Error codes the contract can return, phrased for a worried adult child. */
function humanise(code: string): string {
  switch (code) {
    case 'not_found':
      return 'We could not find that record.'
    case 'no_open_session':
      return 'There is no call in progress to resume.'
    case 'expired':
      return 'This link has expired.'
    case 'unauthorized':
      return 'Please sign in again.'

    // ---- auth (api/auth/routes.py). Each one is a thing the caregiver can act on.
    case 'wrong_code':
      return 'That code is not right. Check the message and try again.'
    case 'no_code':
      return 'That code has already been used. Send a new one.'
    case 'too_many_attempts':
      return 'Too many tries. Send a new code.'
    case 'delivery_failed':
      return 'We could not send to that number. Check it and try again.'

    // ---- password (api/auth/routes.py)
    case 'invalid_credentials':
      // Deliberately vague, matching the server: naming which half was wrong
      // would say whether the account exists.
      return 'That phone or email and password do not match.'
    case 'account_locked':
      return 'Too many attempts. Try again in 15 minutes, or sign in with a code.'
    case 'password_too_short':
      return 'Use at least 8 characters.'
    case 'password_too_long':
      return 'That password is too long.'
    case 'name_required':
      return 'Please enter your name.'

    // ---- onboarding (api/caregiver/routes.py)
    case 'consent_missing':
      return 'All three consents are needed before we can call.'
    case 'no_medicines':
      return 'Add at least one medicine before finishing.'
    case 'multiple_priority':
      return 'Only one medicine can be the priority one.'
    case 'patient_phone_taken':
      return 'That phone number is already set up under another account.'

    default:
      return 'Something went wrong at our end.'
  }
}

/** Caregiver-scoped reads. Mockable — `API_BASE` is the integration switch. */
export const api = {
  get: <T>(path: string) => request<T>(API_BASE, path),
  post: <T>(path: string, body: unknown) =>
    request<T>(API_BASE, path, { method: 'POST', body: JSON.stringify(body) }),
}

/**
 * Auth and onboarding. Never mocked: a fake login is the thing this whole change
 * exists to delete, so these ignore `API_BASE` and always hit the real server.
 */
export const authApi = {
  get: <T>(path: string) => request<T>(AUTH_BASE, path, undefined, AUTH_TIMEOUT_MS),
  post: <T>(path: string, body: unknown) =>
    request<T>(
      AUTH_BASE,
      path,
      { method: 'POST', body: JSON.stringify(body) },
      AUTH_TIMEOUT_MS,
    ),
}
