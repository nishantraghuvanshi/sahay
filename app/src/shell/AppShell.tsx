import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { Home, CalendarDays, Bell, Phone, FileText, MessageSquareQuote, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useIsDesktop } from './useBreakpoint'
import { NAV, TABS } from './nav'

/**
 * One shell, two layouts: sidebar + top bar on desktop, bottom tab bar on a phone.
 * Screens are identical in both.
 */

const ICONS: Record<string, LucideIcon> = {
  '/home': Home,
  '/calendar': CalendarDays,
  '/alerts': Bell,
  '/calls': Phone,
  '/record': FileText,
  '/observations': MessageSquareQuote,
  '/settings': Settings,
}

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

function Wordmark() {
  return (
    <span className="grid size-7 place-items-center rounded-lg bg-ink text-sm font-bold text-paper">
      K
    </span>
  )
}

function Sidebar() {
  return (
    <aside className="flex w-[208px] shrink-0 flex-col gap-1 border-r border-line bg-surface p-4">
      <div className="flex items-center gap-2.5 px-1 pb-4">
        <Wordmark />
        <span className="text-md font-bold tracking-tight">Kinvox</span>
      </div>

      <div className="mb-3 rounded-xl border border-line-strong bg-paper p-3 shadow-[var(--shadow-card)]">
        <div className="text-sm font-semibold">Mom · 71</div>
        <div className="text-2xs text-muted">Care line active</div>
      </div>

      {NAV.map((item) => {
        const Icon = ICONS[item.to] ?? Home
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
    </aside>
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
        const Icon = ICONS[tab.to] ?? Home
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
