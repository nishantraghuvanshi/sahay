import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Sending someone from `/login` to `/signup`, or the other way, without making
 * them type their number again.
 *
 * Both pages hit the same two dead ends. A first-time caregiver types a password
 * into `/login` and there is nothing to match it against; a returning one starts
 * `/signup` and is four steps from discovering they already have an account.
 * Neither is an error the person can fix on the page they are on, so the page
 * says which one they want and takes them there.
 *
 * The delay is the whole point of not navigating immediately: a screen that
 * swaps under you the instant you press a button reads as a bug, and the
 * sentence explaining why is the part they need to have read.
 */
export const AUTH_REDIRECT_MS = 1800

/** What `/login` and `/signup` hand each other through router state. */
export interface AuthHandoff {
  /** Phone or email, already typed once. Prefilled on arrival. */
  identifier?: string
  /** The deep link that bounced through RequireAuth, carried across the hop so a
   *  detour via the other page does not cost the alert someone opened. */
  from?: string
}

export interface PendingRedirect {
  to: '/login' | '/signup'
  identifier: string
  /** Shown while the timer runs. Says what was wrong and where they are going. */
  message: string
}

/** Reads the identifier the other auth page passed over, if any. */
export function useHandoffState(): AuthHandoff {
  const location = useLocation()
  return (location.state as AuthHandoff | null) ?? {}
}

/**
 * Arms a redirect to the other auth page. `redirect` is non-null once armed —
 * render its `message` and disable the form; the navigation follows on its own.
 */
export function useAuthRedirect() {
  const navigate = useNavigate()
  const { from } = useHandoffState()
  const [redirect, setRedirect] = useState<PendingRedirect | null>(null)

  useEffect(() => {
    if (!redirect) return
    const timer = setTimeout(() => {
      const state: AuthHandoff = { identifier: redirect.identifier, from }
      navigate(redirect.to, { replace: true, state })
    }, AUTH_REDIRECT_MS)
    return () => clearTimeout(timer)
  }, [redirect, from, navigate])

  /** Idempotent: arming twice from a double submit must not queue two hops. */
  const arm = useCallback((next: PendingRedirect) => {
    setRedirect((current) => current ?? next)
  }, [])

  return { redirect, arm }
}
