import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { LogoutButton } from '../auth/LogoutButton'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  Card,
  Chip,
  Divider,
  ErrorBlock,
  Field,
  Label,
  LoadingBlock,
  Row,
  Tag,
} from '../ui'
import { useCareRecord } from '../api/hooks'
import { getSubscription } from '../api/billing'

/**
 * `/settings` — frames `1m` (phone) / `2k` (web).
 *
 * The wireframes draw this screen as a wall of switches: tone pickers, retry policy, alert
 * rules, per-contact escalation delays, billing. There is no mutation endpoint behind any of
 * them, so drawing them would mean shipping a screen whose every control silently discards
 * what the caregiver just did. On this product that is worse than showing less: a parent's
 * medicine schedule is the one thing a person must never be wrong about.
 *
 * So this screen states rather than edits. Every line is a stored column of the care record
 * (TRD §3 `patients`, `caregivers`, `medications`) rendered as a value, with a plain note
 * saying where it is changed today. Nothing is shaped like a control it cannot honour.
 *
 * The one exception is Pause calls, because `patients.calls_paused` is a real column and SR-5
 * says the parent may ask us to stop on any call. It is wired to local state only, and the
 * card says so in words — see the TODO below.
 *
 * The Plan card is a statement of the same kind. `subscriptions` and `payments` are real tables
 * now (`api/schema.sql`), so what was paid and what it covers can be read and shown; but nothing
 * cancels, switches or refunds a plan, so the card states the subscription and does not manage
 * it, and the only thing it ever offers is checkout — a page of its own.
 *
 * Deliberately absent: voice and tone, retry policy, alert-rule toggles, notification channels,
 * quiet hours, data export, delete account. Each needs either an endpoint that does not exist
 * or a table that does not exist.
 */

/** Display only. The raw BCP-47 tag is always shown beside it, never replaced. */
const LANGUAGE_LABEL: Record<string, string> = {
  'hi-IN': 'Hindi',
  'en-IN': 'English',
  'mr-IN': 'Marathi',
  'pa-IN': 'Punjabi',
  'bn-IN': 'Bengali',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default function Settings() {
  const record = useCareRecord()

  /**
   * SR-5. Starts from the stored column, then holds only for as long as this screen is open.
   *
   * TODO(Lane B): replace with `POST /app/patients/{id}/pause` ({ paused: boolean }) and
   * invalidate the ['record'] query. Until that endpoint exists this must NOT read as saved —
   * the card below states in words that it lasts only until the screen is reloaded, so a
   * caregiver never walks away believing the calls have been stopped when they have not.
   */
  const [pausedHere, setPausedHere] = useState<boolean | null>(null)

  if (record.isLoading) return <LoadingBlock rows={6} />
  if (record.error) return <ErrorBlock error={record.error} onRetry={() => record.refetch()} />
  if (!record.data) return <LoadingBlock rows={6} />

  const { patient, caregiver, medications } = record.data

  const spokenName = patient.honorific ? `${patient.name}-${patient.honorific}` : patient.name
  const languageLabel = LANGUAGE_LABEL[patient.language]
  const mealTimes = Object.entries(patient.meal_times ?? {})
  const signedOffAt = patient.schedule_signed_off_at

  /** Arithmetic on `medications.slots` — the earliest and latest dose time, nothing invented. */
  const slots = [...new Set(medications.flatMap((m) => m.slots))].sort()
  const windowStart = slots[0]
  const windowEnd = slots[slots.length - 1]

  const storedPaused = patient.calls_paused
  const paused = pausedHere ?? storedPaused
  const pauseDiffersFromRecord = paused !== storedPaused
  const callsRunning = Boolean(signedOffAt) && !paused

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
      {/* --------------------------------------------------------------- header */}
      <Card className="gap-2">
        <Label>Settings</Label>
        <h1 className="text-xl leading-tight font-bold break-words">
          How {spokenName}&rsquo;s calls are set up
        </h1>
        <div className="text-base text-muted-strong">
          This is what the care record says today. Most of it is changed in setup for now, so it
          is shown here as it stands rather than as something to edit.
        </div>
      </Card>

      {/* --------------------------------------------------------------- parent */}
      <Card className="gap-2.5">
        <Row className="flex-wrap gap-2">
          <Label className="flex-1">Parent</Label>
          <Tag outline>changed in setup</Tag>
        </Row>

        <Stated label="Name the agent uses" value={spokenName} />
        <Divider />
        <Stated label="Age" value={patient.age != null ? `${patient.age}` : 'Not recorded'} />
        <Divider />
        <Stated
          label="Language on calls"
          value={languageLabel ? `${languageLabel} · ${patient.language}` : patient.language}
        />
        <Divider />
        <Stated
          label="Phone"
          value={
            <a href={`tel:${patient.phone_e164}`} className="font-semibold break-all underline">
              {patient.phone_e164}
            </a>
          }
        />
        <Divider />
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-strong">Address</span>
          <span className="text-md leading-snug break-words">
            {patient.address_text ?? 'No address recorded.'}
          </span>
        </div>
        <Divider />
        <Stated
          label="Doctor"
          value={
            patient.doctor_name || patient.doctor_phone ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <span className="font-semibold break-words">
                  {patient.doctor_name ?? 'Name not recorded'}
                </span>
                {patient.doctor_phone && (
                  <a href={`tel:${patient.doctor_phone}`} className="font-semibold underline">
                    {patient.doctor_phone}
                  </a>
                )}
              </span>
            ) : (
              'None recorded'
            )
          }
        />

        <div className="text-sm text-muted-strong">
          The full record — conditions, allergies, every medicine —{' '}
          <Link to="/record" className="underline">
            is on the care record
          </Link>
          .
        </div>
      </Card>

      {/* ---------------------------------------------------------------- calls */}
      {/* FR-4 sign-off and the SR-5 pause are two separate columns. Either one alone stops a
          call, so they are stated as two separate lines and never merged into one status. */}
      <Card emphasis={callsRunning ? 'none' : 'rule'} className="gap-2.5">
        <Row className="flex-wrap gap-2">
          <Label className="flex-1">Calls</Label>
          {!signedOffAt && <Tag>not signed off</Tag>}
          {paused && <Tag>paused</Tag>}
        </Row>

        {signedOffAt ? (
          <div className="text-md font-semibold">
            Schedule signed off on {formatDateTime(signedOffAt)}
          </div>
        ) : (
          <>
            <div className="text-lg leading-snug font-bold">
              Not signed off — no call will be placed.
            </div>
            <div className="text-sm text-muted-strong">
              Nothing is called about until you approve the schedule.
            </div>
            <Row>
              <Button variant="outline" href="/medicines/edit">
                Review the schedule
              </Button>
            </Row>
          </>
        )}

        <Divider />

        {/* Call window — derived from the dose times, and labelled as derived. There is no
            call-window column, and inventing one would make this screen unverifiable. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-strong">Call window</span>
          {windowStart ? (
            <>
              <Row className="flex-wrap gap-2">
                <Field value={windowStart} className="w-[84px] text-center" />
                <span className="text-base text-muted-strong">to</span>
                <Field value={windowEnd} className="w-[84px] text-center" />
              </Row>
              <span className="text-sm text-muted-strong">
                Not a setting of its own — the agent calls at the dose times, so the window is the
                first and last of them. Change a time and the window moves with it.
              </span>
            </>
          ) : (
            <span className="text-base text-muted-strong">
              No dose times yet, so there is nothing to call about.
            </span>
          )}
        </div>

        <Divider />

        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-strong">Meal times</span>
          {mealTimes.length > 0 ? (
            <Row className="flex-wrap gap-2">
              {mealTimes.map(([meal, time]) => (
                <Chip key={meal}>
                  {titleCase(meal)} · {time}
                </Chip>
              ))}
            </Row>
          ) : (
            <span className="text-base text-muted-strong">
              None recorded. Before-food and after-food doses are timed from the slot alone.
            </span>
          )}
        </div>
      </Card>

      {/* ---------------------------------------------------------------- pause */}
      {/* The only control on this screen. It is honest about its own reach: the record still
          says what it says, and the card never claims otherwise. */}
      <Card emphasis={paused ? 'rule' : 'none'} className="gap-2.5">
        <Row className="flex-wrap gap-2">
          <Label className="flex-1">Pause calls</Label>
          <Tag outline>{paused ? 'paused here' : 'calling'}</Tag>
        </Row>

        <div className="text-md leading-snug font-semibold">
          {paused
            ? `We are not calling ${patient.name} while this is paused.`
            : `We call ${patient.name} at each dose time.`}
        </div>

        <Row>
          <Button
            variant={paused ? 'primary' : 'outline'}
            onClick={() => setPausedHere(!paused)}
            className="w-full sm:w-auto"
          >
            {paused ? 'Start calls again' : 'Pause calls'}
          </Button>
        </Row>

        <div className="text-sm leading-relaxed text-muted-strong">
          This switch holds only while this screen is open. It is not written to the record yet,
          so if you reload the page it goes back to{' '}
          <span className="font-semibold">
            {storedPaused ? 'paused' : 'calling'}
          </span>
          , which is what the record says.
        </div>

        {pauseDiffersFromRecord && (
          <div className="text-sm leading-relaxed font-semibold">
            Careful: the record still says{' '}
            {storedPaused ? 'calls are paused' : 'calls are running'}. To stop calls for real
            today, tell us on the call or by phone.
          </div>
        )}

        <Divider />

        <div className="text-sm leading-relaxed text-muted-strong">
          {spokenName} can ask us to stop on any call, and we stop straight away — no reason
          needed, no argument from the agent. You are told when that happens.
        </div>
      </Card>

      {/* -------------------------------------------------------- who gets told */}
      {/* There is no escalation_contacts table, so there is no list to render. Saying that in
          words is the only honest option: an empty list would read as "nobody is told". */}
      <Card className="gap-2">
        <Label>Who gets told</Label>
        <div className="text-md font-semibold break-words">
          {caregiver.name}
          {caregiver.relationship ? ` · ${caregiver.relationship}` : ''}
        </div>
        <Row className="flex-wrap gap-2">
          <a href={`tel:${caregiver.phone_e164}`} className="text-md font-semibold underline">
            {caregiver.phone_e164}
          </a>
        </Row>
        <div className="text-sm leading-relaxed text-muted-strong">
          Everything goes to you. No second contact is stored yet, so nobody else is called or
          messaged when something is wrong — not a sibling, not the doctor. If someone else
          should hear about a red alert, ring them yourself for now.
        </div>
        <Row>
          <Button variant="outline" href="/alerts">
            See what has been sent
          </Button>
        </Row>
      </Card>

      {/* ------------------------------------------------------------- account */}
      <Card className="gap-2.5">
        <Row className="flex-wrap gap-2">
          <Label className="flex-1">Your account</Label>
          <Tag outline>changed in setup</Tag>
        </Row>

        <Stated label="Name" value={caregiver.name} />
        <Divider />
        <Stated
          label="Phone"
          value={
            <a href={`tel:${caregiver.phone_e164}`} className="font-semibold underline">
              {caregiver.phone_e164}
            </a>
          }
        />
        <Divider />
        <Stated label="Email" value={caregiver.email ?? 'Not recorded'} />
        <Divider />
        <Stated
          label={`Relationship to ${patient.name}`}
          value={caregiver.relationship ? titleCase(caregiver.relationship) : 'Not recorded'}
        />
      </Card>

      {/* ---------------------------------------------------------------- plan */}
      <PlanCard />

      {/* ------------------------------------------------------------- privacy */}
      <Card className="gap-2">
        <Label>Privacy</Label>
        <div className="flex flex-col gap-2 text-base leading-relaxed">
          <div>
            <span className="font-semibold">Calls are recorded and transcribed.</span> That is how
            a dose gets marked taken and how {patient.name}&rsquo;s own words reach you unchanged.
          </div>
          <div>
            <span className="font-semibold">{spokenName} was told this on the first call</span>,
            in {languageLabel ?? patient.language}, before anything was recorded.
          </div>
          <div>
            <span className="font-semibold">Nothing is summarised away.</span> Every observation
            is stored word for word and shown to you word for word — no mood score, no
            percentage, nothing rewritten to sound better than it was.
          </div>
        </div>
        <Row>
          <Button variant="outline" href="/observations">
            Read the observations
          </Button>
        </Row>
      </Card>

      <p className="px-1 pb-1 text-sm leading-relaxed text-muted-strong">
        Every value on this screen is read from the care record, and the plan from the
        subscription behind it. Apart from the pause switch above, which holds only while this
        screen is open, nothing here changes anything.
      </p>

      {/* Phone has no sidebar, so this is the only way out of the session. */}
      <div className="lg:hidden">
        <LogoutButton className="justify-center border border-line" />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- plan */

/** Paise are what is stored; rupees are what a person was charged. No rounding either way. */
function formatRupees(paise: number): string {
  const rupees = paise / 100
  const fraction = rupees % 1 === 0 ? 0 : 2
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  })}`
}

/**
 * What was paid for, and until when. `subscriptions` and `payments` exist, so this is read
 * rather than guessed — but no endpoint cancels or switches a plan, so there is no control
 * here that could pretend to. The date is only ever called a renewal when a period has
 * actually been paid for; an expired plan says it ended, and a cancelled one says how far
 * it is paid up.
 */
function PlanCard() {
  const billing = useQuery({ queryKey: ['billing'], queryFn: getSubscription })

  /* Skeleton in the shape this card ends up in — label, then the lines it will hold. */
  if (billing.isLoading || !billing.data) {
    if (billing.error) {
      return <ErrorBlock error={billing.error} onRetry={() => billing.refetch()} />
    }
    return (
      <Card className="gap-2.5">
        <Label>Plan</Label>
        <LoadingBlock rows={3} />
      </Card>
    )
  }

  const { subscription, pending_order_id } = billing.data

  /* Nothing on the record. Either a payment is mid-flight, or none has been started. */
  if (!subscription) {
    return (
      <Card emphasis="rule" className="gap-2.5">
        <Row className="flex-wrap gap-2">
          <Label className="flex-1">Plan</Label>
          <Tag>{pending_order_id ? 'payment not verified' : 'no plan'}</Tag>
        </Row>

        {pending_order_id ? (
          <>
            <div className="text-md leading-snug font-semibold">
              A payment is waiting to be verified.
            </div>
            <div className="text-sm leading-relaxed text-muted-strong">
              It has been made but not confirmed back to us yet, so no plan is on the record.
              Open the one already in progress rather than starting a second — that is how a
              card gets charged twice.
            </div>
            <Row>
              <Button variant="outline" href="/checkout">
                Open that payment
              </Button>
            </Row>
          </>
        ) : (
          <>
            <div className="text-md leading-snug font-semibold">No plan on this account.</div>
            <div className="text-sm leading-relaxed text-muted-strong">
              Nothing has been paid for yet. A plan is chosen at checkout, not here.
            </div>
            <Row>
              <Button href="/checkout?plan=care">Choose a plan</Button>
            </Row>
          </>
        )}
      </Card>
    )
  }

  const active = subscription.status === 'active'
  const endLabel = active ? 'Renews on' : subscription.status === 'expired' ? 'Ended' : 'Paid up to'

  return (
    <Card emphasis={active ? 'none' : 'rule'} className="gap-2.5">
      <Row className="flex-wrap gap-2">
        <Label className="flex-1">Plan</Label>
        {/* Word first, shape second — the status is never carried by colour. */}
        {active ? <Tag outline>active</Tag> : <Tag>{subscription.status}</Tag>}
      </Row>

      <div className="text-md leading-snug font-semibold">{subscription.plan_name}</div>

      <Divider />
      <Stated label="Price" value={formatRupees(subscription.amount_paise)} />
      <Divider />
      <Stated
        label="This period started"
        value={formatDateTime(subscription.current_period_start)}
      />
      <Divider />
      <Stated label={endLabel} value={formatDateTime(subscription.current_period_end)} />

      {/* A lapsed plan is the one non-active state with something to do about it, and
          leaving it with no way forward would strand a paying caregiver on the screen
          that told them they had lapsed. Renewing is another checkout — the same one —
          because a renewal here is a second payment and not a stored mandate. */}
      {!active && (
        <Row>
          <Button href={`/checkout?plan=${subscription.plan}`}>
            Pay for another month
          </Button>
        </Row>
      )}

      <div className="text-sm leading-relaxed text-muted-strong">
        This card says what is on the subscription. Stopping a plan or moving to another one is
        not wired into the app yet, so there is no button here that would look like it did.
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------- one stated line */

/** Label left, value right. A statement, not a field — it is never focusable and never edits. */
function Stated({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Row className="flex-wrap gap-2">
      <span className="min-w-0 flex-1 text-sm text-muted-strong">{label}</span>
      <span className="text-right text-md font-semibold break-all">{value}</span>
    </Row>
  )
}
