import { Link } from 'react-router-dom'

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__brand">
          <span className="footer__logo">Kinvox</span>
          <p>Care that stays on track.</p>
        </div>
        <nav className="footer__links" aria-label="Footer">
          <a href="#how-it-works">How it works</a>
          <a href="#for-families">For families</a>
          <a href="#pricing">Pricing</a>
          <Link to="/signup">Get started</Link>
        </nav>
      </div>
      <p className="footer__note">
        © {new Date().getFullYear()} Kinvox. Your data is safe and never shared.
      </p>
    </footer>
  )
}
