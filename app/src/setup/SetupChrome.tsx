import { Outlet } from 'react-router-dom'
import SessionBar from '../shell/SessionBar'

/**
 * The one piece of chrome the signed-in, shell-free screens get: a way out.
 *
 * `/setup/*` and `/checkout` render outside AppShell deliberately — no tab bar
 * during onboarding, no wandering off mid-payment. The cost was that they had no
 * sign-out either, and they are the screens a caregiver is most likely to be
 * stuck on: a new account has no household, so RequireHousehold sends it to
 * /setup/meet, and `/` sends anyone with a session to /home, which bounces
 * straight back. Without this bar the only way out of that loop is clearing a
 * cookie by hand.
 */
export default function SetupChrome() {
  return (
    <div className="flex min-h-full flex-col">
      <SessionBar />
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
