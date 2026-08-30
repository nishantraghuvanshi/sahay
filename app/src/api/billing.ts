import { API_BASE } from '../config'
import { ApiError, api } from './client'

/**
 * UPI checkout (api/payments/routes.py).
 *
 * Payment is a P2P UPI transfer to our VPA, matched back to an order by two
 * things: an amount whose last two paise are unique to the order, and the UTR
 * the caregiver copies out of their payment app. There is no gateway callback,
 * so nothing here can know a payment landed — a person confirms it, and the
 * screen says so.
 *
 * Live only, for the same reason `postOnboarding` is: `API_BASE=/mock` means
 * there is no server to charge, and a mock that returned a cheerful order id
 * would be a fake receipt. Money is the one place a fixture is worse than a
 * refusal.
 */
const live = API_BASE !== '/mock'

function requireLive() {
  if (!live) throw new ApiError('No Care API configured — nothing was charged.', 'unreachable')
}

export type PlanKey = 'care' | 'care_plus'

export type Plan = {
  key: PlanKey
  name: string
  /** Paise, not rupees — the display string is the server's job, not ours. */
  paise: number
  includes: string[]
}

/** `configured:false` means no payee VPA is set on this deployment: checkout cannot run. */
export type PlansResponse = {
  ok: true
  configured: boolean
  plans: Plan[]
}

export type Order = {
  order_id: string
  plan: string
  plan_name: string
  amount_paise: number
  /** Already formatted by the server, e.g. "499.37". Render it, never re-round it. */
  amount_display: string
  payee_vpa: string
  payee_name: string
  /** `upi://pay?...` — the deep link the QR encodes. Never send it to a third party. */
  upi_url: string
  expires_at: string
}

export type OrderStatus = 'created' | 'claimed' | 'confirmed' | 'expired'

export type OrderView = {
  order_id: string
  plan: string
  plan_name: string
  amount_paise: number
  amount_display: string
  status: OrderStatus
  utr: string | null
  expires_at: string
  confirmed_at: string | null
}

export type ClaimResponse = { ok: true; status: 'claimed' | 'confirmed' }

export async function getPlans(): Promise<PlansResponse> {
  requireLive()
  return api.get<PlansResponse>('/app/billing/plans')
}

export async function createOrder(plan: PlanKey): Promise<{ ok: true; order: Order }> {
  requireLive()
  return api.post<{ ok: true; order: Order }>('/app/billing/checkout', { plan })
}

export async function claimPayment(order_id: string, utr: string): Promise<ClaimResponse> {
  requireLive()
  return api.post<ClaimResponse>('/app/billing/claim', { order_id, utr })
}

export async function getOrder(order_id: string): Promise<{ ok: true; order: OrderView }> {
  requireLive()
  return api.get<{ ok: true; order: OrderView }>(`/app/billing/order/${order_id}`)
}

/**
 * FR-30 — what a confirmed payment bought, as Settings renders it.
 *
 * `pending_order_id` is a payment already in flight (issued, or claimed and
 * awaiting a human). Settings uses it to say "we are checking a payment"
 * instead of offering a second checkout on top of the first.
 *
 * Read-only. There is no cancel and no plan change: no endpoint mutates a
 * subscription, and a control that silently discards what the caregiver did is
 * worse on this product than one that is absent.
 */
export type Subscription = {
  plan: PlanKey
  plan_name: string
  status: 'active' | 'expired' | 'cancelled'
  amount_paise: number
  current_period_start: string
  current_period_end: string
}

export type BillingState = {
  subscription: Subscription | null
  pending_order_id: string | null
}

export async function getSubscription(): Promise<BillingState> {
  /**
   * The one billing call that does NOT refuse in mock mode. The reason the rest
   * do is that a fixture order id is a fake receipt; "you are not on a plan" is
   * neither fake nor a receipt, it is the truth about a deployment with no
   * billing behind it. Throwing here put an error card in the middle of
   * Settings on every mock run, which reads as a broken screen rather than as
   * an unconfigured one.
   */
  if (!live) return { subscription: null, pending_order_id: null }
  return api.get<BillingState>('/app/billing/subscription')
}
