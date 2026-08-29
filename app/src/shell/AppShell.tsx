import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { useIsDesktop } from './useBreakpoint'
import { NAV, TABS } from './nav'
import { Wordmark } from '../ui'
import { useCareRecord } from '../api/hooks'

/**
 * One shell, two layouts: sidebar + top bar on desktop (wireframe 2e),
 * bottom tab bar on a phone (wireframe 1f). Screens are identical in both.
 */
export default function AppShell() {
  const isDesktop = useIsDesktop()

  if (isDesktop) {
    return (
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1 overflow-auto p-3">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="flex w-[186px] shrink-0 flex-col gap-1 border-r border-line bg-surface p-3">
      <div className="flex items-center gap-2 px-2 pb-3">
        <Wordmark size={19} />
      </div>

      <PatientCard />

      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-base transition-colors duration-150 ease-out',
              isActive
                ? 'bg-accent-soft font-semibold text-accent'
                : 'text-muted-strong hover:bg-line/60 hover:text-ink',
            )
          }
        >
          <item.icon size={17} strokeWidth={2} aria-hidden="true" />
          {item.label}
        </NavLink>
      ))}
    </aside>
  )
}

/** Reads the record rather than asserting an identity — the sidebar used to disagree with it. */
function PatientCard() {
  const { data } = useCareRecord()
  const patient = data?.patient
  return (
    <div className="mb-2 rounded-lg border border-line-strong bg-paper p-2">
      <div className="text-base font-semibold">
        {patient ? `${patient.name}${patient.honorific ? `-${patient.honorific}` : ''}` : '—'}
        {patient?.age != null && ` · ${patient.age}`}
      </div>
      <div className="text-2xs text-muted-strong">
        {patient?.calls_paused
          ? 'Calls paused'
          : patient?.schedule_signed_off_at
            ? 'Calls active'
            : 'Not signed off'}
      </div>
    </div>
  )
}

function TabBar() {
  return (
    <nav className="flex shrink-0 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            clsx(
              'flex flex-1 flex-col items-center gap-1 py-2 text-2xs transition-colors duration-150 ease-out',
              isActive ? 'font-bold text-accent' : 'text-muted-strong',
            )
          }
        >
          {({ isActive }) => (
            <>
              <tab.icon
                size={19}
                strokeWidth={isActive ? 2.4 : 1.9}
                aria-hidden="true"
                className="transition-colors duration-150 ease-out"
              />
              {tab.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
