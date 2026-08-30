import { Link } from 'react-router-dom'

/** Keeps the #for-healthcare-pros id: the footer still links here. */
export default function CtaBand() {
  return (
    <section className="cta-band" id="for-healthcare-pros">
      {/* Was an anchor to #waitlist. The page's one ask is now an account. */}
      <Link className="btn btn--dark cta-band__btn" to="/signup">
        Get started &rarr;
      </Link>
    </section>
  )
}
