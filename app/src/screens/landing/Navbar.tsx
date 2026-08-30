import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`navbar${scrolled ? ' navbar--scrolled' : ''}`}>
      <div className="navbar__inner">
        <a className="logo" href="#top" aria-label="Kinvox home">
          <span>Kinvox</span>
        </a>
        <nav className="navbar__links" aria-label="Primary">
          <a href="#how-it-works">How it works</a>
          <a href="#for-families">For families</a>
          <a href="#pricing">Pricing</a>
        </nav>
        {/* Was a single "Join Waitlist" anchor. There is a product behind the
            page now, so the two real doors are signing up and coming back. */}
        <div className="navbar__actions">
          <Link className="btn btn--light navbar__cta" to="/login">
            Log in
          </Link>
          <Link className="btn btn--dark navbar__cta" to="/signup">
            Get started
          </Link>
        </div>
      </div>
    </header>
  )
}
