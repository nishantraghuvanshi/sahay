import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useCareRecord } from '../api/hooks'
import { ApiError } from '../api/client'

/**
 * A caregiver with a session but no patient yet belongs in onboarding, not on /home.
 *
 * This state was unreachable while `/app/record` ignored the session and answered
 * with whichever household onboarded most recently — a brand new caregiver was
 * shown a family that was not theirs, and the app never had to decide what an
 * empty account looks like. Now that the read is scoped, the honest answer is
 * `not_found`, and without this guard the first thing a new caregiver sees after
 * signing up is an error card.
 *
 * A redirect and not an empty state, for the reason RequireAuth is a redirect:
 * there is exactly one useful thing to do here, so do it.
 */
export default function RequireHousehold() {
  const record = useCareRecord()
  const location = useLocation()

  // Still asking. Render nothing rather than flashing chrome that is about to be
  // replaced by a redirect.
  if (record.isPending) return null

  const notFound = record.error instanceof ApiError && record.error.code === 'not_found'
  if (notFound) {
    // Step one of onboarding, not the last screen they happened to leave: the
    // draft in localStorage may be from a different browser, a different parent,
    // or nothing at all.
    return <Navigate to="/setup/meet" replace state={{ from: location.pathname }} />
  }

  // Any other failure — the API is down, the request timed out — is not "you have
  // no household", and must not send someone through onboarding a second time.
  // The screens render their own ErrorBlock for that.
  return <Outlet />
}
