import { useNavigate } from 'react-router-dom'
import { SignInPage } from '@/components/ui/sign-in'
import { AuthSteps } from '../../setup/AuthSteps'

/**
 * Wireframe 1a — creating an account. "Get started" lands here.
 *
 * Same split-screen block as `/login`, but the left column is the five gated
 * steps instead of a password form: phone → its code → email → its code → name
 * and password. `SignInPage` takes them as `children`, which swaps out the
 * built-in form and keeps the hero and the entrance animation.
 *
 * `reveal="active"` draws one step at a time under a progress rail. Stacked, the
 * five cards are four sets of disabled inputs and a scrollbar — a form to read
 * rather than a thing to do. The landing column keeps the stacked view on
 * purpose: there, showing the whole shape of signup is the pitch.
 *
 * <AuthSteps> is untouched and still the single implementation shared with the
 * landing page's 376px column — the OTP handling, the server cooldown and the
 * is_new routing must not fork.
 *
 * The previous card layout is preserved verbatim at the bottom of this file.
 */

/* No testimonials. Kinvox has no users yet, so there are none to quote —
   PRODUCT.md: "No real testimonials, pricing proof, or live-user data — do not
   fabricate any." The hero panel renders without them. */

export default function Signup() {
  const navigate = useNavigate()

  return (
    <SignInPage
      title={<span className="font-display font-light tracking-tight text-foreground">Create your account</span>}
      description="One account, one parent to start."
      heroImageSrc="https://images.unsplash.com/photo-1642615835477-d303d7dc9ee9?w=2160&q=80"
    >
      <div className="animate-element animate-delay-300 flex flex-col gap-3">
        <AuthSteps variant="inset" reveal="active" />
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="font-semibold text-violet-400 hover:underline"
          >
            Sign in
          </button>
        </p>
      </div>
    </SignInPage>
  )
}

/* ------------------------------------------------------------------ previous
   The card layout this page used before the split-screen block. Kept for
   reference / rollback — delete once the new one has held for a while. */

// import { Link } from 'react-router-dom'
// import { Wordmark } from '../../ui'
// import { AuthSteps } from '../../setup/AuthSteps'
//
// /**
//  * Wireframe 1a — creating an account. "Get started" lands here.
//  *
//  * Five gated steps: phone → its code → email → its code → name and password.
//  * The codes prove the two channels once; the password is what the caregiver
//  * actually signs in with afterwards, on `/login`.
//  *
//  * The machine lives in setup/AuthSteps.tsx so this page and the landing page's
//  * 376px column drive one implementation — otherwise the server cooldown and the
//  * is_new routing drift apart within a day.
//  */
// export default function Signup() {
//   return (
//     <main className="flex min-h-full w-full flex-col lg:items-center lg:py-14">
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
//         <div className="flex flex-col gap-1">
//           <h1 className="text-2xl leading-tight font-bold">Create your account</h1>
//           <p className="text-base text-muted-strong">
//             One account, one parent to start.
//           </p>
//         </div>
//
//         <AuthSteps variant="page" />
//       </div>
//
//       {/* Desktop only: the way back to the pitch, for someone who arrived here
//           cold and wants to know what this is before handing over a number. */}
//       <p className="pt-4 text-center text-sm text-muted-strong lg:pt-6">
//         Already have an account?{' '}
//         <Link to="/login" className="font-semibold text-ink underline">
//           Sign in
//         </Link>
//       </p>
//     </main>
//   )
// }
