import { createContext, useContext, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import { setUnauthorizedHandler } from '../api/client'
import { auth, type Caregiver } from './api'
import { DEV_MODE } from '../config'
import { DEV_CAREGIVER } from '../setup/devSeed'

/**
 * Who is signed in, for the whole app.
 *
 * Three states, and the third one matters: `undefined` means we have not heard
 * back yet. Collapsing it into `null` would bounce every caregiver to /login for
 * a frame on every cold load, including the ones who are perfectly signed in.
 */
type Session = Caregiver | null | undefined

const SessionContext = createContext<Session>(undefined)

export const SESSION_KEY = ['session'] as const

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()

  const { data, isPending } = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      if (DEV_MODE) return DEV_CAREGIVER
      try {
        return (await auth.me()).caregiver
      } catch (err) {
        // 401 is the expected answer for a signed-out visitor, not a failure.
        // Anything else is a real fault and should surface as one.
        if (err instanceof ApiError && err.status === 401) return null
        throw err
      }
    },
    // A signed-out answer must not be retried into a slow redirect, and the
    // session is not something a background refetch should churn.
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  })

  // Any 401 from anywhere — an expired session hit mid-session — drops the
  // cached caregiver, which re-renders RequireAuth and sends them to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => queryClient.setQueryData(SESSION_KEY, null))
  }, [queryClient])

  return (
    <SessionContext.Provider value={isPending ? undefined : (data ?? null)}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): Session {
  return useContext(SessionContext)
}
