import { Wordmark } from '../../ui'
import { AuthSteps } from '../../setup/AuthSteps'

/**
 * Wireframe 1a — the phone-native form of signing in.
 *
 * The four-step machine itself lives in setup/AuthSteps.tsx, because the desktop
 * landing page (2a) carries the same four cards in its 376px column. This screen
 * is the mobile framing around it: wordmark, headline, and the steps.
 */
export default function Login() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-3 p-5">
      <Wordmark size={26} className="self-start" />
      <h1 className="text-2xl leading-tight font-bold">
        Keep an eye on
        <br />
        your parent&rsquo;s meds
      </h1>
      <p className="text-base text-muted-strong">We call them. You only hear what matters.</p>

      <AuthSteps variant="page" />
    </main>
  )
}
