import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Card, Label } from '../ui'
import { ApiError } from '../api/client'
import { auth } from '../auth/api'
import { SESSION_KEY } from '../auth/SessionProvider'

/**
 * Returning caregiver: identifier + password, one request.
 *
 * The OTP proves the phone once, at signup. Making someone wait on an SMS every
 * session would be the slowest possible way to open an app they check daily —
 * and on the demo path, the least reliable.
 *
 * The server answers `invalid_credentials` for every failure, whatever actually
 * went wrong, so this form cannot be used to discover who has an account.
 */
export default function PasswordLogin({ onSignUp }: { onSignUp: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const [identifier, setIdentifier] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await auth.login(identifier.trim(), pw)
      queryClient.setQueryData(SESSION_KEY, res.caregiver)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from ?? '/home', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.')
      setPw('')
    } finally {
      setBusy(false)
    }
  }

  const ready = identifier.trim().length > 0 && pw.length > 0

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) void submit()
      }}
    >
      <Card emphasis="border" className="gap-2">
        <Label>Phone or email</Label>
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="+91 98765 43210"
          autoComplete="username"
          aria-label="Phone or email"
          className={inputCls}
        />
        <Label>Password</Label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Your password"
          autoComplete="current-password"
          aria-label="Password"
          className={inputCls}
        />
        {error && (
          <p role="alert" aria-live="polite" className="text-sm font-semibold text-ink">
            {error}
          </p>
        )}
        <Button disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </Card>

      <p className="text-center text-sm text-muted-strong">
        First time here?{' '}
        <button type="button" onClick={onSignUp} className="font-semibold text-ink underline">
          Create an account
        </button>
      </p>
    </form>
  )
}

const inputCls =
  'w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-md text-ink outline-none placeholder:text-muted-strong focus:border-ink disabled:text-muted-strong'
