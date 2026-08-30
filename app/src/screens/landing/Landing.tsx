import { Link } from 'react-router-dom'
import Navbar from './Navbar'
import Hero from './Hero'
import FeatureSections from './FeatureSections'
import Pricing from './Pricing'
import CtaBand from './CtaBand'
import Footer from './Footer'
import { useSetupDraft } from '../../setup/store'
import './landing.css'

/**
 * `/` — the marketing page, ported from the standalone voxikin-waitlist site.
 *
 * What changed in the port:
 *
 *  - The waitlist is gone. Formspree, the email/phone form, the segmented
 *    control and the success card had one job — collecting an address for a
 *    product that did not exist yet — and there is a product now. Everywhere the
 *    old page said "join the waitlist" it now opens /signup.
 *  - The orb lost its answering pulse, which existed to acknowledge a successful
 *    signup on this page. Nothing on this page completes any more.
 *  - Pricing came across from the app's previous landing page: /checkout is live,
 *    and the waitlist site had no prices to show.
 *
 * Styling is the site's own — Inter and Fraunces on white, sienna accent — kept
 * in landing.css and scoped to `.vx-landing` so the app's cream Tailwind theme
 * is untouched on every other route. See the header comment in that file.
 */
export default function Landing() {
  const { draft } = useSetupDraft()
  // Someone who started signing up and came back should not have to find their
  // way in again. The draft is the only thing that survives a reload pre-session.
  //
  // Read off the parent/prescription steps, not `draft.phone`: the auth fields are
  // no longer persisted (store.ts), so a phone number is only ever present in the
  // tab that typed it and would offer the banner to nobody who reloaded.
  const started = Boolean(draft.parentName || draft.files.length || draft.medicines.length)
  const resumable = started && !draft.scheduleConfirmed

  return (
    <div className="vx-landing">
      <Navbar />

      {resumable && (
        <Link className="resume" to="/login">
          Continue where you left off &rarr;
        </Link>
      )}

      <main>
        <Hero />
        <FeatureSections />
        <Pricing />
        <CtaBand />
      </main>

      <Footer />
    </div>
  )
}
