import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { useIsDesktop } from './useBreakpoint'
import { NAV, TABS } from './nav'
import { Bar, Dot, Wordmark } from '../ui'
import { useCareRecord } from '../api/hooks'
import { LogoutButton } from '../auth/LogoutButton'

/**
 * One shell, two layouts: sidebar + top bar on desktop, bottom tab bar on a phone.
 * Screens are identical in both.
 */

export default function AppShell() {
  const isDesktop = useIsDesktop()
  const mainRef = useRouteFocus()

  if (isDesktop) {
    return (
      <div className="flex h-full">
        <SkipLink />
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main id="main" ref={mainRef} tabIndex={-1} className="min-h-0 flex-1 overflow-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <main id="main" ref={mainRef} tabIndex={-1} className="min-h-0 flex-1 overflow-auto p-4">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

/**
 * A tab change swaps the whole screen but leaves focus sitting on the tab that was
 * clicked, so a screen-reader user hears nothing and a keyboard user resumes tabbing
 * from the nav on every navigation. Moving focus to <main> announces the new screen
 * and puts the next Tab at the top of the content. Scroll resets with it: arriving at
 * a new screen already scrolled halfway down is the same bug, felt with a mouse.
 */
function useRouteFocus() {
  const ref = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    ref.current?.scrollTo({ top: 0 })
  }, [pathname])
  return ref
}

/** Seven sidebar links stand between the keyboard and the content on every page. */
function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
    >
      Skip to content
    </a>
  )
}

function Sidebar() {
  return (
    <aside className="flex w-[208px] shrink-0 flex-col gap-1 border-r border-line bg-surface p-4">
      <div className="flex items-center px-1 pb-4">
        <Wordmark size={17} />
      </div>

      <PatientCard />

      {/* The tab bar is a <nav>; the sidebar was seven bare links in an <aside>, so it
          did not appear in the landmark list a screen reader navigates by. */}
      <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map((item) => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors duration-150',
                isActive
                  ? 'bg-ink font-semibold text-paper'
                  : 'font-medium text-muted-strong hover:bg-fill/60 hover:text-ink',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className="size-[18px] shrink-0" strokeWidth={isActive ? 2 : 1.5} />
                {item.label}
              </>
            )}
          </NavLink>
        )
      })}
      </nav>

      <div className="mt-auto pt-3">
        <LogoutButton />
      </div>
    </aside>
  )
}


/** Reads the record rather than asserting an identity — the sidebar used to disagree with it. */
function PatientCard() {
  const { data } = useCareRecord()
  const patient = data?.patient

  /**
   * This line used to read "Care line active" unconditionally — it said the calls were
   * running while the record was still loading, while the schedule was unsigned, and
   * while the parent had asked us to stop. In a product whose posture is "no invented
   * urgency, no invented reassurance", chrome that asserts a service is up without
   * checking is the worst kind of lie: it is quiet, and it is comforting.
   *
   * Three real states, in the order that outranks: no sign-off means no call may EVER
   * be placed (FR-4), then the parent's own pause (SR-5), then running.
   */
  const line = !patient
    ? null
    : patient.schedule_signed_off_at === null
      ? ({ mark: 'empty', tone: 'ink', text: 'Not signed off' } as const)
      : patient.calls_paused
        ? ({ mark: 'hollow', tone: 'warn', text: 'Calls paused' } as const)
        : ({ mark: 'filled', tone: 'accent', text: 'Calls active' } as const)

  return (
    <div className="mb-3 rounded-xl border border-line-strong bg-paper p-3 shadow-[var(--shadow-card)]">
      {patient && line ? (
        <>
          <div className="text-sm font-semibold">
            {patient.name}
            {patient.age !== null && ` · ${patient.age}`}
          </div>
          {/* Shape + word, like every other status in the system — never the hue alone. */}
          <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-strong">
            <Dot kind={line.mark} tone={line.tone} className="size-2" />
            {line.text}
          </div>
        </>
      ) : (
        // Nothing is claimed until the record answers.
        <div className="flex flex-col gap-1.5" aria-busy="true">
          <Bar width="70%" className="h-3" />
          <Bar width="45%" className="h-2" />
          <span className="sr-only">Loading the care record</span>
        </div>
      )}
    </div>
  )
}

function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-6">
      <span className="font-display text-lg font-medium tracking-tight">Kinvox</span>
      <span className="text-xs text-muted-strong">the care line, at a glance</span>
    </header>
  )
}

function TabBar() {
  return (
    <nav className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tab) => {
        const Icon = tab.icon
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              clsx(
                'relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors duration-150',
                isActive ? 'text-accent' : 'text-muted-strong',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute top-0 h-[3px] w-9 rounded-b-full bg-accent" />
                )}
                <Icon className="size-[22px]" strokeWidth={isActive ? 2 : 1.5} />
                <span>{tab.label}</span>
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}
