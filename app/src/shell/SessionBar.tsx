import { LogoutButton } from '../auth/LogoutButton'
import { Wordmark } from '../ui'

/**
 * A slim strip carrying the brand and the way out of the session.
 *
 * Used by the two places that had no sign-out at all: the phone layout, whose
 * only chrome is a four-tab bar that must never grow a fifth item, and the
 * shell-free screens (`/setup/*`, `/checkout`). On desktop the sidebar already
 * carries one, so this does not appear there.
 *
 * In normal flow, never fixed or floating. Every screen underneath owns its own
 * top corners — a back arrow, "1 / 4", "Optional", "Not now" — and an overlaid
 * control would land on one of them.
 */
export default function SessionBar() {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-3 py-1.5">
      {/* The shared mark, not a typed-out name: it carries the rule and the tittle,
          and it is the one place the brand string lives. TopBar still hardcodes
          its own — worth collapsing into this, but not from here. */}
      <Wordmark className="text-[15px]" />
      {/* w-auto beats the primitive's w-full: a full-width row in the sidebar and
          in Settings, a compact control here. */}
      <LogoutButton className="w-auto px-2 py-1.5" />
    </div>
  )
}
