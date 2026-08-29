import { Link, useNavigate } from 'react-router-dom'
import { Wordmark } from '../../ui'
import PasswordLogin from '../../setup/PasswordLogin'

/**
 * Signing in — a returning caregiver, phone or email plus password.
 *
 * Creating an account is a different page (`/signup`, reached from "Get
 * started"). Splitting them keeps this one short: someone opening the app for
 * the fourth time this week should see two fields, not five gated steps.
 *
 * One narrow column at both widths. A phone gets it full-bleed; a desktop gets
 * the same column on a card, centred with room above and below.
 */
export default function Login() {
  const navigate = useNavigate()

  return (
    <main className="flex min-h-full w-full flex-col lg:items-center lg:py-16">
      <div
        className="
          mx-auto flex min-h-full w-full max-w-md flex-col gap-3 p-5
          lg:min-h-0 lg:max-w-[420px] lg:rounded-xl lg:border lg:border-line-strong
          lg:bg-paper lg:p-8 lg:shadow-[var(--shadow-card)]
        "
      >
        <Link to="/" aria-label="Kinvox home" className="self-start">
          <Wordmark size={26} />
        </Link>

        <div className="flex flex-col gap-1 pb-1">
          <h1 className="text-2xl leading-tight font-bold">Welcome back</h1>
          <p className="text-base text-muted-strong">
            Sign in to see how your parent is doing.
          </p>
        </div>

        <PasswordLogin onSignUp={() => navigate('/signup')} />
      </div>

      {/* Desktop only: the way back to the pitch, for someone who arrived here
          cold and wants to know what this is before handing over a number. */}
      <p className="hidden pt-6 text-sm text-muted-strong lg:block">
        New here?{' '}
        <Link to="/" className="font-semibold text-ink underline">
          See how Kinvox works
        </Link>
      </p>
    </main>
  )
}
