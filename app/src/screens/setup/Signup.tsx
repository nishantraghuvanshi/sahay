import { Link } from 'react-router-dom'
import { Wordmark } from '../../ui'
import { AuthSteps } from '../../setup/AuthSteps'

/**
 * Wireframe 1a — creating an account. "Get started" lands here.
 *
 * Five gated steps: phone → its code → email → its code → name and password.
 * The codes prove the two channels once; the password is what the caregiver
 * actually signs in with afterwards, on `/login`.
 *
 * The machine lives in setup/AuthSteps.tsx so this page and the landing page's
 * 376px column drive one implementation — otherwise the server cooldown and the
 * is_new routing drift apart within a day.
 */
export default function Signup() {
  return (
    <main className="flex min-h-full w-full flex-col lg:items-center lg:py-14">
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

        <div className="flex flex-col gap-1">
          <h1 className="text-2xl leading-tight font-bold">Create your account</h1>
          <p className="text-base text-muted-strong">
            One account, one parent to start.
          </p>
        </div>

        <AuthSteps variant="page" />
      </div>

      {/* Desktop only: the way back to the pitch, for someone who arrived here
          cold and wants to know what this is before handing over a number. */}
      <p className="pt-4 text-center text-sm text-muted-strong lg:pt-6">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-ink underline">
          Sign in
        </Link>
      </p>
    </main>
  )
}
