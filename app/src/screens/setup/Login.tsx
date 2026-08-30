import type React from 'react'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SignInPage } from '@/components/ui/sign-in'
import { ApiError } from '../../api/client'
import { auth } from '../../auth/api'
import { SESSION_KEY } from '../../auth/SessionProvider'

/**
 * Signing in — a returning caregiver, phone or email plus password.
 *
 * The form is now the split-screen `components/ui/sign-in` block: the fields on
 * the left and the hero on the right (desktop only, so a
 * phone still gets one clean column). The auth itself is unchanged — the same
 * single `POST /auth/login`, the same deep-link-aware landing, the same
 * deliberately vague `invalid_credentials` for every kind of failure, so the
 * form cannot be used to discover who has an account.
 *
 * The previous card layout is preserved verbatim at the bottom of this file.
 */

/* No testimonials. Kinvox has no users yet, so there are none to quote —
   PRODUCT.md: "No real testimonials, pricing proof, or live-user data — do not
   fabricate any." The hero panel renders without them. */

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSignIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return

    const form = new FormData(event.currentTarget)
    const identifier = String(form.get('identifier') ?? '').trim()
    const password = String(form.get('password') ?? '')
    if (!identifier || !password) {
      setError('Enter your phone or email and your password.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const res = await auth.login(identifier, password)
      queryClient.setQueryData(SESSION_KEY, res.caregiver)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from ?? '/home', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SignInPage
      title={<span className="font-display font-light tracking-tight text-foreground">Welcome back</span>}
      description="Sign in to see how your parent is doing."
      heroImageSrc="https://images.unsplash.com/photo-1642615835477-d303d7dc9ee9?w=2160&q=80"
      identifierName="identifier"
      identifierType="text"
      identifierLabel="Phone or email"
      identifierPlaceholder="+91 98765 43210"
      submitLabel="Sign in"
      busyLabel="Signing in…"
      busy={busy}
      error={error}
      onSignIn={(e) => void onSignIn(e)}
      /* No Google OAuth on the API yet — offering the button would be a dead end. */
      showGoogle={false}
      /* No reset endpoint yet either; the OTP path at /signup is the recovery. */
      showResetPassword={false}
      createAccountPrompt="First time here?"
      createAccountLabel="Create an account"
      onCreateAccount={() => navigate('/signup')}
    />
  )
}

/* ------------------------------------------------------------------ previous
   The card layout this page used before the split-screen block. Kept for
   reference / rollback — delete once the new one has held for a while. */

// import { Link, useNavigate } from 'react-router-dom'
// import { Wordmark } from '../../ui'
// import PasswordLogin from '../../setup/PasswordLogin'
//
// /**
//  * Signing in — a returning caregiver, phone or email plus password.
//  *
//  * Creating an account is a different page (`/signup`, reached from "Get
//  * started"). Splitting them keeps this one short: someone opening the app for
//  * the fourth time this week should see two fields, not five gated steps.
//  *
//  * One narrow column at both widths. A phone gets it full-bleed; a desktop gets
//  * the same column on a card, centred with room above and below.
//  */
// export default function Login() {
//   const navigate = useNavigate()
//
//   return (
//     <main className="flex min-h-full w-full flex-col lg:items-center lg:py-16">
//       <div
//         className="
//           mx-auto flex min-h-full w-full max-w-md flex-col gap-3 p-5
//           lg:min-h-0 lg:max-w-[420px] lg:rounded-xl lg:border lg:border-line-strong
//           lg:bg-paper lg:p-8 lg:shadow-[var(--shadow-card)]
//         "
//       >
//         <Link to="/" aria-label="Kinvox home" className="self-start">
//           <Wordmark size={26} />
//         </Link>
//
//         <div className="flex flex-col gap-1 pb-1">
//           <h1 className="text-2xl leading-tight font-bold">Welcome back</h1>
//           <p className="text-base text-muted-strong">
//             Sign in to see how your parent is doing.
//           </p>
//         </div>
//
//         <PasswordLogin onSignUp={() => navigate('/signup')} />
//       </div>
//
//       {/* Desktop only: the way back to the pitch, for someone who arrived here
//           cold and wants to know what this is before handing over a number. */}
//       <p className="hidden pt-6 text-sm text-muted-strong lg:block">
//         New here?{' '}
//         <Link to="/" className="font-semibold text-ink underline">
//           See how Kinvox works
//         </Link>
//       </p>
//     </main>
//   )
// }
