/** The four tabs (wireframe 1f) plus the desktop-only sidebar entries (2e). */
export type NavItem = { to: string; label: string; tab: boolean }

export const NAV: NavItem[] = [
  { to: '/home', label: 'Home', tab: true },
  { to: '/calendar', label: 'Calendar', tab: true },
  { to: '/alerts', label: 'Alerts', tab: true },
  { to: '/calls', label: 'Calls', tab: true },
  { to: '/record', label: 'Care record', tab: false },
  { to: '/observations', label: 'What she said', tab: false },
  { to: '/settings', label: 'Settings', tab: false },
]

export const TABS = NAV.filter((n) => n.tab)
