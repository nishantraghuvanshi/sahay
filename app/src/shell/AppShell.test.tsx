import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AppShell from './AppShell'
import { getSubscription } from '../api/billing'
import type { BillingState } from '../api/billing'

/**
 * The sidebar's Upgrade entry is the only nav item whose presence is a claim
 * about the caregiver's money: showing it to someone already paying, or to
 * someone whose transfer we are still checking, invites a second payment on top
 * of the first. Settings refuses to do that; the sidebar has to refuse too.
 */

vi.mock('./useBreakpoint', () => ({ useIsDesktop: () => true }))

vi.mock('../api/hooks', () => ({
  useCareRecord: () => ({ data: undefined, isPending: false, error: null }),
}))

vi.mock('../auth/LogoutButton', () => ({ LogoutButton: () => null }))

vi.mock('../api/billing', () => ({ getSubscription: vi.fn() }))

const subscription = vi.mocked(getSubscription)

const NO_PLAN: BillingState = { subscription: null, pending_order_id: null }

const ACTIVE: BillingState = {
  subscription: {
    plan: 'care',
    plan_name: 'Care',
    status: 'active',
    amount_paise: 49900,
    current_period_start: '2026-08-01T00:00:00Z',
    current_period_end: '2026-09-01T00:00:00Z',
  },
  pending_order_id: null,
}

function renderShell() {
  // No retries: a rejected billing read must resolve within the test, not be
  // retried three times into a timeout.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/home']}>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const upgrade = () => screen.queryByRole('link', { name: 'Upgrade' })

describe('AppShell sidebar — the Upgrade entry', () => {
  beforeEach(() => {
    subscription.mockReset()
  })

  it('offers Upgrade to a caregiver on no plan, pointed at checkout', async () => {
    subscription.mockResolvedValue(NO_PLAN)
    renderShell()

    await waitFor(() => expect(upgrade()).toBeInTheDocument())
    expect(upgrade()).toHaveAttribute('href', '/checkout?plan=care')
  })

  it('hides it from someone already on an active plan', async () => {
    subscription.mockResolvedValue(ACTIVE)
    renderShell()

    // The other sidebar links prove the shell rendered, so an absent Upgrade is
    // a decision rather than an empty sidebar.
    await waitFor(() => expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument())
    expect(upgrade()).not.toBeInTheDocument()
  })

  it('hides it while a payment is still being checked', async () => {
    subscription.mockResolvedValue({ subscription: null, pending_order_id: 'ord_1' })
    renderShell()

    await waitFor(() => expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument())
    expect(upgrade()).not.toBeInTheDocument()
  })

  it('stays hidden when billing cannot be read at all', async () => {
    subscription.mockRejectedValue(new Error('billing down'))
    renderShell()

    await waitFor(() => expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument())
    expect(upgrade()).not.toBeInTheDocument()
  })
})
