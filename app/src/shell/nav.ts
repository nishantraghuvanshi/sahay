import { House, CalendarDays, TriangleAlert, Phone, FileText, MessageSquareQuote, Settings, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** The four tabs (wireframe 1f) plus the desktop-only sidebar entries (2e). */
export type NavItem = { to: string; label: string; tab: boolean; icon: LucideIcon }

export const NAV: NavItem[] = [
  { to: '/home', label: 'Home', tab: true, icon: House },
  { to: '/calendar', label: 'Calendar', tab: true, icon: CalendarDays },
  { to: '/alerts', label: 'Alerts', tab: true, icon: TriangleAlert },
  { to: '/calls', label: 'Calls', tab: true, icon: Phone },
  { to: '/record', label: 'Care record', tab: false, icon: FileText },
  { to: '/observations', label: 'What she said', tab: false, icon: MessageSquareQuote },
  { to: '/settings', label: 'Settings', tab: false, icon: Settings },
  /**
   * Upgrade is the one entry the sidebar hides: a caregiver already paying, or
   * with a payment we are still checking, must not be offered a second
   * checkout on top of the first (the rule Settings already follows). See
   * Sidebar in AppShell.tsx — the filter lives there because only it can read
   * the billing state.
   */
  { to: '/checkout?plan=care', label: 'Upgrade', tab: false, icon: Sparkles },
]

/** Nav entries that are conditional on something the shell has to look up. */
export const UPGRADE_PATH = '/checkout?plan=care'

export const TABS = NAV.filter((n) => n.tab)
