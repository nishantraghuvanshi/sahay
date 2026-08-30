import { Link } from 'react-router-dom'

/**
 * Not on the waitlist site — there was nothing to buy then. Carried across from
 * the app's previous landing page, because /checkout is live and this is the
 * only place the page names a price.
 *
 * `plan` is the billing plan a tier buys, and `null` for the trial — a free trial
 * is a sign-up, not a payment, so it is the one tier that does not go to checkout.
 */
const TIERS: {
  name: string
  price: string
  unit: string
  includes: string[]
  cta: string
  featured: boolean
  plan: 'care' | 'care_plus' | null
}[] = [
  {
    name: 'Trial',
    price: 'Free',
    unit: 'for 7 days',
    includes: ['1 dose slot a day', 'Inbound line'],
    cta: 'Start free',
    featured: false,
    plan: null,
  },
  {
    name: 'Care',
    price: '₹499',
    unit: 'per month',
    includes: [
      'Up to 2 dose slots a day',
      'Inbound line',
      'Caregiver app',
      'Escalations to your family',
    ],
    cta: 'Choose Care',
    featured: true,
    plan: 'care',
  },
  {
    name: 'Care+',
    price: '₹999',
    unit: 'per month',
    includes: ['Unlimited dose slots', 'Priority-medicine alerts', 'Read-only handoff links'],
    cta: 'Choose Care+',
    featured: false,
    plan: 'care_plus',
  },
]

export default function Pricing() {
  return (
    <section className="pricing" id="pricing" aria-labelledby="pricing-title">
      <div className="pricing__head">
        <h2 className="pricing__title" id="pricing-title">
          Priced below the Indian consumer benchmark.
        </h2>
        <p className="pricing__lede">
          Billed on adherence, not on minutes. The closest comparable product is ₹1,499 a
          month and needs your parent to own and use a smartphone.
        </p>
      </div>

      <div className="pricing__grid">
        {TIERS.map((t) => (
          <div key={t.name} className={`tier${t.featured ? ' tier--featured' : ''}`}>
            <div className="tier__head">
              <span className="tier__name">{t.name}</span>
              {t.featured && <span className="tier__badge">most families</span>}
            </div>
            <div className="tier__price">
              <span className="tier__amount">{t.price}</span>
              <span className="tier__unit">{t.unit}</span>
            </div>
            <ul className="tier__includes">
              {t.includes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Link
              className={`btn ${t.featured ? 'btn--dark' : 'btn--light'}`}
              to={t.plan ? `/checkout?plan=${t.plan}` : '/signup'}
            >
              {t.cta}
            </Link>
          </div>
        ))}
      </div>

      {/* Said "UPI checkout is not connected yet" until 30 Aug 2026, when a real
          payment cleared end to end (KVX-UFUS). The line came down then and not
          when the code merged — the sentence was about money moving, not about a
          branch landing. */}
      <p className="pricing__note">
        Paid plans start after the trial. Checkout is UPI — pay from any app on your phone,
        no card and no account with us.
      </p>
    </section>
  )
}
