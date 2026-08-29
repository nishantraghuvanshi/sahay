import { API_BASE } from '../config'

/**
 * The Care API answers HTTP 200 even on failure — errors are data, `{ok:false,error}`
 * (TRD §5.1, NFR-6). That is right for the voice agent, which must never hear silence,
 * and wrong for a UI: an error rendered as data is a screen quietly showing nothing.
 * So the wrapper inverts it — `{ok:false}` becomes a thrown ApiError.
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

const TIMEOUT_MS = 3000

type Envelope<T> = ({ ok: true } & T) | { ok: false; error: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
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
    default:
      return 'Something went wrong at our end.'
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
}
