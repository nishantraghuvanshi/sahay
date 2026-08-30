import type React from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SignInPage } from '@/components/ui/sign-in'
import { ApiError } from '../../api/client'
import { auth } from '../../auth/api'
import { SESSION_KEY } from '../../auth/SessionProvider'
import { useAuthRedirect, useHandoffState } from '../../auth/redirect'

/**
 * Signing in — a returning caregiver, phone or email plus password.
 *
 * The form is the split-screen `components/ui/sign-in` block: the fields on the
 * left and the hero on the right (desktop only, so a phone still gets one clean
 * column). The auth itself is one `POST /auth/login` and a deep-link-aware
 * landing.
 *
 * What this page will not do is tell a first-time caregiver their password is
 * wrong. They have no password — that is the whole of their problem, and the
 * only useful thing to say is "you need an account first", followed by taking
 * them there with the number they just typed already in the field. `no_account`
 * and `signup_incomplete` are separate codes from the server for exactly this;
 * see the note on `/auth/check` in api/auth/routes.py for why auth stopped being
 * blind here.
 *
 * The previous card layout is preserved verbatim at the bottom of this file.
 */

/* No testimonials. Voxikin has no users yet, so there are none to quote —
   PRODUCT.md: "No real testimonials, pricing proof, or live-user data — do not
   fabricate any." The hero panel renders without them. */

export default function Login() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { identifier: prefill, from } = useHandoffState()
  const { redirect, arm } = useAuthRedirect()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSignIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || redirect) return

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
      navigate(from ?? '/home', { replace: true })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''

      // Not a credentials problem — a wrong-page problem. Both of these are
      // resolved on /signup and neither is resolvable here, so say so and go.
      if (code === 'no_account') {
        arm({
          to: '/signup',
          identifier,
          message: 'No account yet for that phone or email. Taking you to sign up…',
        })
        return
      }
      if (code === 'signup_incomplete') {
        arm({
          to: '/signup',
          identifier,
          message:
            'That signup was never finished, so there is no password yet. Taking you back to finish it…',
        })
        return
      }

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
      identifierDefaultValue={prefill ?? ''}
      submitLabel="Sign in"
      busyLabel="Signing in…"
      /* While the redirect timer runs the form is inert: the answer is on the
         next page and a second submit would only start a second hop. */
      busy={busy || redirect !== null}
      error={redirect ? redirect.message : error}
      onSignIn={(e) => void onSignIn(e)}
      /* No Google OAuth on the API yet — offering the button would be a dead end. */
      showGoogle={false}
      /* No reset endpoint yet either; the OTP path at /signup is the recovery. */
      showResetPassword={false}
      createAccountPrompt="First time here?"
      createAccountLabel="Create an account"
      onCreateAccount={() => navigate('/signup', { state: { from } })}
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
//         <Link to="/" aria-label="Voxikin home" className="self-start">
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
//           See how Voxikin works
//         </Link>
//       </p>
//     </main>
//   )
// }
