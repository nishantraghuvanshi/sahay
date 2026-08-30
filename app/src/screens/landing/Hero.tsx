import { lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import SketchBackdrop from './SketchBackdrop'

// three.js is ~170kb gzipped — far more than the whole rest of this page.
// Splitting it out keeps it off the critical path: the hero copy and the
// buttons paint first, the orb fades in once its chunk lands.
const GenerativeOrb = lazy(() => import('./GenerativeOrb'))

export default function Hero() {
  return (
    <section className="hero" id="top">
      <SketchBackdrop />

      <div className="hero__inner">
        <div className="hero__visual">
          <Suspense fallback={<div className="orb orb--placeholder" />}>
            <GenerativeOrb />
          </Suspense>
        </div>

        <div className="hero__content">
          <h1 className="hero__title">
            Caring for your loved ones, no matter where life takes you
          </h1>

          {/* The waitlist card stood here. The product exists now, so the same
              space asks for the account instead of the email address. */}
          <p className="hero__sub">
            We call your parent on schedule, confirm every dose in their own
            language, and tell you only what actually needs you. They install
            nothing — their entire interface is answering a phone call.
          </p>

          <div className="hero__actions">
            <Link className="btn btn--dark" to="/signup">
              Get started free
            </Link>
            <a className="btn btn--light" href="#how-it-works">
              See how it works
            </a>
          </div>

          <p className="hero__privacy">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <rect
                x="5"
                y="10.5"
                width="14"
                height="9.5"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M8 10.5V8a4 4 0 018 0v2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              />
            </svg>
            Your data is safe and never shared.
          </p>
        </div>
      </div>
    </section>
  )
}
