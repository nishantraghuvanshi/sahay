import { useNavigate } from 'react-router-dom'
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
  const navigate = useNavigate()

  async function handleLogout() {
    try {
      await auth.logout()
    } finally {
      queryClient.setQueryData(SESSION_KEY, null)
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] })
      navigate('/login', { replace: true })
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-strong transition-colors duration-150 hover:bg-fill/60 hover:text-ink ${className ?? ''}`}
    >
      <LogOut className="size-[18px] shrink-0" strokeWidth={1.5} />
      Log out
    </button>
  )
}
