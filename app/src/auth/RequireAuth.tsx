import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useSession } from './SessionProvider'

/**
 * The gate that was missing: every route under AppShell mounted unconditionally,
 * so typing /home went straight past login.
 *
 * Modelled on the FR-4 gate in Consent.tsx — a redirect, not a disabled button,
 * because a guard that only hides its own link is not a guard.
 */
export default function RequireAuth() {
  const session = useSession()
  const location = useLocation()

  // Still resolving. Render nothing rather than a spinner: /auth/me answers in
  // milliseconds, and a flash of loading chrome on every navigation reads worse
  // than a beat of blank.
  if (session === undefined) return null

  if (session === null) {
    // `from` so a deep link survives the detour — someone opening a link to an
    // alert lands on that alert after signing in, not on the home screen.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <Outlet />
}
