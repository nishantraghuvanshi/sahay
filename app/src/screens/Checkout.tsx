import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { LIVE_POLL_MS } from '../config'
import { Button, Card, Divider, ErrorBlock, Label, LoadingBlock, Row, Tag } from '../ui'
import { claimPayment, createOrder, getOrder, getPlans } from '../api/billing'
import type { Order, PlanKey } from '../api/billing'

/**
 * UPI checkout.
 *
 * There is no payment gateway behind this. The caregiver pays a plain UPI
 * transfer to our VPA and we match it back to their order two ways: the last
 * two paise of the amount are unique to the order, and they type in the UTR
 * their payment app gives them. A person then checks the bank statement and
 * confirms it.
 *
 * That shapes the whole screen:
 *
 *   - The exact amount is the largest thing on it, with the reason it must be
 *     exact next to it. A caregiver who rounds 499.37 to 499 has made a payment
 *     we cannot match, and they will not find that out for a day.
 *   - The QR is drawn in this browser from the order's own `upi_url`. A hosted
 *     QR service would mean handing a payment link to a third party to render.
 *   - After the claim, the screen says a person is checking it. Nothing here
 *     spins, ticks up, or implies the money has landed. It has not, until
 *     someone says it has.
 */

const UTR_LENGTH = 12

/** Rupees for display from paise. Whole rupees stay whole; paise show as paise. */
function rupees(paise: number): string {
  const whole = paise % 100 === 0
  return (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })
}

function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

export default function Checkout() {
  const [params] = useSearchParams()
  const wanted: PlanKey = params.get('plan') === 'care_plus' ? 'care_plus' : 'care'

  const plans = useQuery({ queryKey: ['billing', 'plans'], queryFn: getPlans, retry: false })

  const [order, setOrder] = useState<Order | null>(null)
  const [claimed, setClaimed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)

  const plan = plans.data?.plans.find((p) => p.key === wanted) ?? null

  async function startOrder() {
    setCreating(true)
    setOrderError(null)
    try {
      const res = await createOrder(wanted)
      setOrder(res.order)
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : 'Something went wrong at our end.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-bold sm:text-xl">Pay by UPI</h1>
        <Link to="/settings" className="shrink-0 text-sm font-semibold text-muted-strong underline">
          Not now
        </Link>
      </header>

      {claimed && order ? (
        <Waiting order={order} />
      ) : order ? (
        <Pay order={order} onClaimed={() => setClaimed(true)} />
      ) : plans.isPending ? (
        // Skeleton in the shape the plan card will take, so nothing moves when it lands.
        <Card>
          <LoadingBlock rows={4} />
        </Card>
      ) : plans.isError ? (
        <ErrorBlock error={plans.error} onRetry={() => plans.refetch()} />
      ) : !plans.data?.configured ? (
        <Card emphasis="rule">
          <Label>Not available</Label>
          <div className="text-sm font-semibold">
            Payments are not switched on for this deployment yet.
          </div>
          <p className="text-sm leading-relaxed text-muted-strong">
            Nothing has been charged and nothing is waiting on you. Everything you have
            already set up keeps working.
          </p>
          <Row>
            <Button variant="outline" href="/settings">
              Back to settings
            </Button>
          </Row>
        </Card>
      ) : !plan ? (
        <Card emphasis="rule">
          <Label>Not available</Label>
          <div className="text-sm font-semibold">That plan does not exist.</div>
          <p className="text-sm leading-relaxed text-muted-strong">
            The link you followed names a plan we do not sell. Nothing has been charged.
          </p>
          <Row>
            <Button variant="outline" href="/settings">
              Back to settings
            </Button>
          </Row>
        </Card>
      ) : (
        <Card>
          <Row>
            <h2 className="flex-1 text-md font-bold">{plan.name}</h2>
            <Tag outline>monthly</Tag>
          </Row>

          <div className="tnum font-display text-3xl font-semibold">₹{rupees(plan.paise)}</div>
          <p className="text-sm text-muted-strong">per month, paid by UPI</p>

          <Divider />

          <Label>what you get</Label>
          <ul className="flex flex-col gap-1.5">
            {plan.includes.map((line) => (
              <li key={line} className="flex items-start gap-2 text-sm leading-relaxed">
                <span className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-accent" />
                <span className="flex-1">{line}</span>
              </li>
            ))}
          </ul>

          <Divider />

          <p className="text-sm leading-relaxed text-muted-strong">
            The next screen shows an amount a few paise off ₹{rupees(plan.paise)}. Those
            last two paise are how we recognise your payment, so it is the amount to pay
            exactly.
          </p>

          {orderError && <p className="text-sm font-semibold text-danger">{orderError}</p>}

          <Row>
            <Button variant="accent" onClick={startOrder} disabled={creating}>
              {creating ? 'Setting up the payment…' : `Pay ₹${rupees(plan.paise)} by UPI`}
            </Button>
          </Row>
        </Card>
      )}
    </main>
  )
}

/* ------------------------------------------------------------------- pay */

function Pay({ order, onClaimed }: { order: Order; onClaimed: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  const [utr, setUtr] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Drawn here, in the browser. The alternative — an <img> pointed at a QR
   * service — would send the payee VPA, the amount and the order reference to
   * someone else's server to be rendered. A payment link does not leave this tab.
   */
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(order.upi_url, { margin: 1, width: 240 })
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null))
    return () => {
      alive = false
    }
  }, [order.upi_url])

  const digits = utr.replace(/\D/g, '')
  const ready = digits.length === UTR_LENGTH

  async function submit() {
    setSending(true)
    setError(null)
    try {
      await claimPayment(order.order_id, digits)
      onClaimed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong at our end.')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Card emphasis="border">
        <Label>pay exactly this</Label>
        <div className="tnum font-display text-4xl font-semibold">₹{order.amount_display}</div>
        <p className="text-sm leading-relaxed">
          <strong className="font-semibold">
            The amount must be exact, to the paise.
          </strong>{' '}
          The last two paise are how we match your payment to your account — no gateway
          tells us it arrived, this number does. Rounding it means we cannot find it.
        </p>
        <Divider />
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-strong">Pay to</dt>
            <dd className="font-semibold select-all">{order.payee_vpa}</dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-strong">Name shown</dt>
            <dd className="font-semibold select-all">{order.payee_name}</dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-strong">Reference</dt>
            <dd className="tnum font-semibold select-all">{order.order_id}</dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-strong">Plan</dt>
            <dd className="font-semibold">{order.plan_name}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-strong">
          This payment reference is good until {clockTime(order.expires_at)}. After that,
          start again from this screen — no money moves either way.
        </p>
      </Card>

      <Card>
        <Label>scan with any UPI app</Label>
        <div className="flex justify-center py-1">
          {qr ? (
            <img
              src={qr}
              width={240}
              height={240}
              alt={`UPI payment code for ₹${order.amount_display} to ${order.payee_vpa}`}
              className="rounded-lg border border-line-strong bg-paper p-2"
            />
          ) : (
            // Same 240px box the code will occupy, so the card does not jump.
            <div className="size-[240px] rounded-lg border border-line-strong bg-fill" aria-hidden />
          )}
        </div>
        <p className="text-center text-xs text-muted-strong">
          The code already carries the exact amount. Check it against ₹
          {order.amount_display} in your app before you pay.
        </p>

        {/* On a phone the QR is unscannable — it is on the screen doing the scanning.
            The deep link opens BHIM / GPay / PhonePe with the amount already filled. */}
        <a
          href={order.upi_url}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border-[1.5px] border-ink bg-transparent px-4 py-2.5 text-center text-sm font-semibold text-ink transition-[transform,background-color] duration-150 ease-[var(--ease-out)] hover:bg-ink/[0.05] active:scale-[0.98] sm:hidden"
        >
          Open your UPI app
        </a>
      </Card>

      <Card>
        <Label>then enter the UPI reference</Label>
        <p className="text-sm leading-relaxed text-muted-strong">
          Your payment app shows a 12-digit UTR or reference number on the receipt. Type
          it here so we can find your payment in the bank statement.
        </p>
        <input
          value={utr}
          onChange={(e) => setUtr(e.target.value.replace(/\D/g, '').slice(0, UTR_LENGTH))}
          inputMode="numeric"
          autoComplete="off"
          maxLength={UTR_LENGTH}
          aria-label="12-digit UPI reference number"
          placeholder="12-digit UTR"
          className="tnum w-full rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-md tracking-[0.12em] outline-none placeholder:tracking-normal placeholder:text-muted-strong focus:border-ink"
        />

        {error && <p className="text-sm font-semibold text-danger">{error}</p>}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button variant="accent" onClick={submit} disabled={!ready || sending}>
            {sending ? 'Sending the reference…' : 'I have paid'}
          </Button>
          {/* Rule 7: the button stays visibly disabled and the reason sits beside it. */}
          <span className="text-sm text-muted-strong">
            {ready
              ? 'We will check this against the bank statement.'
              : `${digits.length} of ${UTR_LENGTH} digits entered.`}
          </span>
        </div>
      </Card>
    </>
  )
}

/* --------------------------------------------------------------- claimed */

function Waiting({ order }: { order: Order }) {
  /**
   * Poll until a person confirms. `refetchInterval` returning false is what
   * stops it — a confirmed order is final, and there is nothing left to ask.
   */
  const q = useQuery({
    queryKey: ['billing', 'order', order.order_id],
    queryFn: () => getOrder(order.order_id),
    refetchInterval: (query) =>
      query.state.data?.order.status === 'confirmed' ? false : LIVE_POLL_MS,
  })

  const status = q.data?.order.status
  const utr = q.data?.order.utr

  const confirmedAt = useMemo(() => {
    const at = q.data?.order.confirmed_at
    return at ? clockTime(at) : null
  }, [q.data?.order.confirmed_at])

  if (status === 'confirmed') {
    return (
      <Card emphasis="border">
        <Row>
          <span className="inline-block size-2.5 shrink-0 rounded-full bg-accent" />
          <Label className="flex-1">payment confirmed</Label>
        </Row>
        <h2 className="font-display text-lg font-semibold">
          {order.plan_name} is active.
        </h2>
        <p className="text-sm leading-relaxed text-muted-strong">
          We matched ₹{order.amount_display}
          {utr ? ` against reference ${utr}` : ''}
          {confirmedAt ? `, confirmed at ${confirmedAt}` : ''}. Nothing else is needed
          from you.
        </p>
        <Row>
          <Button href="/settings">Go to settings</Button>
        </Row>
      </Card>
    )
  }

  return (
    <Card emphasis="rule">
      <Row>
        <span className="inline-block size-2.5 shrink-0 rounded-full border-2 border-ink bg-paper" />
        <Label className="flex-1">
          {status === 'expired' ? 'reference expired' : 'waiting on a person'}
        </Label>
      </Row>

      {status === 'expired' ? (
        <>
          <h2 className="font-display text-lg font-semibold">
            This payment reference expired before it was matched.
          </h2>
          <p className="text-sm leading-relaxed text-muted-strong">
            If the money did leave your account, it is not lost — write to us with
            reference {order.order_id} and we will find it. If it did not, nothing has
            been charged and you can start again.
          </p>
        </>
      ) : (
        <>
          <h2 className="font-display text-lg font-semibold">
            Thank you. A person is checking your payment.
          </h2>
          <p className="text-sm leading-relaxed">
            We have your reference{utr ? ` (${utr})` : ''} and the amount ₹
            {order.amount_display}. Someone here matches it against the bank statement by
            hand — there is no gateway to tell us instantly. Your plan turns on the moment
            that is done, and this screen updates itself.
          </p>
          <p className="text-sm leading-relaxed text-muted-strong">
            You can close this and come back. Nothing depends on you keeping it open, and
            the calls you have already set up carry on as normal in the meantime.
          </p>
        </>
      )}

      <Divider />
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-strong">Reference</dt>
          <dd className="tnum font-semibold select-all">{order.order_id}</dd>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-strong">Plan</dt>
          <dd className="font-semibold">{order.plan_name}</dd>
        </div>
      </dl>

      <Row>
        <Button variant="outline" href="/settings">
          Back to settings
        </Button>
      </Row>
    </Card>
  )
}
