import { useEffect, useState } from 'react'
import { useInView } from './useInView'
import onboardingImg from './assets/onboarding-steps.webp'
import everyDoseImg from './assets/every-dose-tracked.webp'
import careOnTrackImg from './assets/care-on-track.webp'
import knowWhenImg from './assets/know-when-it-matters.webp'

// Each panel's visible headline lives inside its image. The `title` here is
// the section's accessible name — rendered as a real heading for document
// structure and screen readers, not repeated on screen.
// Intrinsic dimensions are declared so the browser reserves the space before
// the image decodes; without them these four panels shift the page on load.
const SECTIONS = [
  {
    id: 'how-it-works',
    title: 'How it works',
    image: onboardingImg,
    width: 1340,
    height: 1024,
    alt: 'Onboard with four easy steps: help us understand the patient, upload your prescription, review the schedule, and relax — we take care of the rest.',
  },
  {
    id: 'every-dose',
    title: 'Never a missed dose',
    image: everyDoseImg,
    width: 1452,
    height: 1083,
    alt: 'Call timeline showing a completed call, the next call for Metformin 500 mg after food twice daily, and an upcoming scheduled call — every dose tracked, always on time.',
  },
  {
    id: 'for-families',
    title: 'For families',
    image: careOnTrackImg,
    width: 1454,
    height: 1082,
    alt: "Family app showing Mum's care: 92% adherence, 6 days of medicine left, a week of confirmed doses, and today's summary — care that stays on track.",
  },
  {
    id: 'alerts',
    title: 'Real-time alerts',
    image: knowWhenImg,
    width: 1451,
    height: 1084,
    alt: 'Alert feed with a critical alert quoting "I feel dizzy and my chest is tight", a missed dose retry, and a no-pickup notice — know when it matters.',
  },
]

export default function FeatureSections() {
  const [gridRef, inView] = useInView()
  // The panels are only hidden once JS has confirmed it can reveal them again.
  // Without this the default stylesheet would blank the section for anyone
  // whose script never runs.
  const [armed, setArmed] = useState(false)

  useEffect(() => setArmed(true), [])

  const className = ['features', armed && 'features--armed', inView && 'features--in']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} ref={gridRef}>
      {SECTIONS.map(({ id, title, image, alt, width, height }) => (
        <section key={id} id={id} className="feature" aria-labelledby={`${id}-title`}>
          <h2 className="sr-only" id={`${id}-title`}>
            {title}
          </h2>
          <figure className="feature__figure">
            <img
              src={image}
              alt={alt}
              width={width}
              height={height}
              loading="lazy"
              decoding="async"
            />
          </figure>
        </section>
      ))}
    </div>
  )
}
