import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { useIsDesktop } from './useBreakpoint'
import { NAV, TABS } from './nav'

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
          <TopBar />
          <main className="min-h-0 flex-1 overflow-auto p-5">
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
        <span className="grid size-6 place-items-center rounded-md bg-ink text-[11px] font-bold text-white">
          K
        </span>
        <span className="text-[13px] font-bold">Kinvox</span>
      </div>

      <div className="mb-2 rounded-lg border border-line-strong bg-paper p-2">
        <div className="text-[12px] font-semibold">Mom · 71</div>
        <div className="text-[10px] text-muted">no data yet</div>
      </div>

      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            clsx(
              'rounded-lg px-3 py-2 text-[12px]',
              isActive ? 'bg-ink font-bold text-white' : 'text-muted-strong hover:bg-line/50',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </aside>
  )
}

function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
      <span className="text-[15px] font-bold">Kinvox</span>
      <span className="rounded-full border border-line-strong bg-paper px-2 py-0.5 text-[10px]">
        scaffold
      </span>
    </header>
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
              'flex flex-1 flex-col items-center gap-1 py-2 text-[10px]',
              isActive ? 'font-bold text-ink' : 'text-muted',
            )
          }
        >
          {({ isActive }) => (
            <>
              <span
                className={clsx(
                  'size-4 rounded border',
                  isActive ? 'border-ink bg-ink' : 'border-line-strong',
                )}
              />
              {tab.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
