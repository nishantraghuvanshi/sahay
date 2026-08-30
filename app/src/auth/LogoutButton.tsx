import { useQueryClient } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import { auth } from './api'
import { SESSION_KEY } from './SessionProvider'

/**
 * Ends the session on the server, then drops every cached query — the care record
 * belongs to the caregiver who just left, and must not flash for the next one.
 */
export function LogoutButton({ className }: { className?: string }) {
  const queryClient = useQueryClient()

  async function handleLogout() {
    try {
      await auth.logout()
    } finally {
      queryClient.setQueryData(SESSION_KEY, null)
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] })

      // `/`, not `/login`. Logging out is leaving, not being interrupted, and the
      // login form asks someone who just chose to go for the credentials they
      // just put down. RequireAuth still sends an *expired* session to /login,
      // which is the opposite case: they were reaching for a screen and should
      // land back on it once they sign in.
      //
      // A document navigation, not `navigate()`, because an in-app one loses a
      // race it cannot win: clearing the session above re-renders RequireAuth,
      // which is still mounted over this screen, and its <Navigate to="/login">
      // commits after ours and replaces it. Reloading also guarantees the thing
      // the comment above promises — no component state belonging to the last
      // caregiver survives into the next session, cached or not.
      window.location.replace('/')
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-strong transition-colors duration-150 hover:bg-fill/60 hover:text-ink ${className ?? ''}`}
    >
      <LogOut className="size-[18px] shrink-0" strokeWidth={2} />
      Log out
    </button>
  )
}
