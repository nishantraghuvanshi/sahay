import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { useIsDesktop } from './useBreakpoint'
import { NAV, TABS } from './nav'
import { Wordmark } from '../ui'
import { useCareRecord } from '../api/hooks'
import { LogoutButton } from '../auth/LogoutButton'

/**
 * One shell, two layouts: sidebar + top bar on desktop, bottom tab bar on a phone.
 * Screens are identical in both.
 */

export default function AppShell() {
  const isDesktop = useIsDesktop()

  if (isDesktop) {
    return (
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1 overflow-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1 overflow-auto p-4">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="flex w-[208px] shrink-0 flex-col gap-1 border-r border-line bg-surface p-4">
      <div className="flex items-center px-1 pb-4">
        <Wordmark size={17} />
      </div>

      <PatientCard />

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
                <Icon className="size-[18px] shrink-0" strokeWidth={isActive ? 2.4 : 2} />
                {item.label}
              </>
            )}
          </NavLink>
        )
      })}

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
  return (
    <div className="mb-3 rounded-xl border border-line-strong bg-paper p-3 shadow-[var(--shadow-card)]">
      <div className="text-sm font-semibold">
        {patient ? `${patient.name} · ${patient.age}` : '—'}
      </div>
      <div className="text-2xs text-muted">Care line active</div>
    </div>
  )
}

function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-6 backdrop-blur">
      <span className="font-display text-lg font-semibold tracking-tight">Kinvox</span>
      <span className="text-xs text-muted-strong">the care line, at a glance</span>
    </header>
  )
}

function TabBar() {
  return (
    <nav className="flex shrink-0 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
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
                <Icon className="size-[22px]" strokeWidth={isActive ? 2.5 : 2} />
                <span className={clsx(isActive && 'font-bold')}>{tab.label}</span>
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}
