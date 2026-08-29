import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Settings as SettingsIcon } from 'lucide-react'
import {
  Button,
  Card,
  Chip,
  Divider,
  DoseStatusChip,
  Dot,
  EmptyBlock,
  ErrorBlock,
  Label,
  Row,
  SeverityChip,
  Tag,
} from '../ui'
import {
  useCalls,
  useCareRecord,
  useDaySummary,
  useDoseHistory,
  useEscalations,
  useObservations,
} from '../api/hooks'
import { nextDose, relativeTime } from '../lib/schedule'
import type { DaySummaryItem } from '../api/types'

/**
 * The tab the caregiver opens twenty times a day. Two questions, answered without scrolling:
 * is anything wrong (the critical alert leads, loud, when there is one), and did she take her
 * medicines (the next dose, then a merged chronological stream of everything since 6 AM).
 *
 * A calm day is mostly whitespace and one reassuring line; a bad day opens with a red banner.
 */
export default function Home() {
  const record = useCareRecord()
  const doses = useDoseHistory()
  const summary = useDaySummary()
  const observations = useObservations()
  const escalations = useEscalations()
  const calls = useCalls()

  if (record.isLoading || doses.isLoading) return <HomeSkeleton />
  if (record.error) return <ErrorBlock error={record.error} onRetry={() => record.refetch()} />

  const patient = record.data!.patient
  const name = patient.name
  const meds = record.data!.medications
  const events = doses.data ?? []
  const next = nextDose(meds, events)

  const openAlert = escalations.data?.[0]
  const lastCall = [...(calls.data ?? [])]
    .filter((c) => c.status !== 'no_answer')
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
  const lastCallObservation = observations.data?.find((o) => o.call_session_id === lastCall?.id)
  const lastCallDoses = events.filter((e) => e.call_session_id === lastCall?.id)

  const openCount = escalations.data?.length ?? 0
  const weekAgo = Date.now() - 7 * 86_400_000
  const saidThisWeek = (observations.data ?? []).filter(
    (o) => new Date(o.created_at).getTime() >= weekAgo,
  )

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {/* ------------------------------------------ header (1f): who, how, ⚙ settings.
          Desktop has the sidebar for both, so this row is phone-only. */}
      <Row className="lg:hidden">
        <div className="flex-1 min-w-0">
          <div className="text-md font-bold truncate">{name}</div>
          <div className="text-xs text-muted-strong">
            {openCount > 0 ? `${openCount} open ${openCount === 1 ? 'alert' : 'alerts'}` : 'On track today'}
          </div>
        </div>
        <Link
          to="/settings"
          aria-label="Settings"
          className="grid size-11 place-items-center rounded-full text-muted-strong hover:bg-fill/60 hover:text-ink"
        >
          <SettingsIcon className="size-5" strokeWidth={2} />
        </Link>
      </Row>

      {/* ------------------------------------------------ needs you — leads, loud */}
      {openAlert && (
        <Card emphasis="danger" className="kv-rise gap-3">
          <Row className="flex-wrap gap-2">
            <Tag tone="danger">{openAlert.level}</Tag>
            <Label className="text-danger">Needs you now</Label>
            <Label className="ml-auto tnum">
              {openAlert.sent_at ? relativeTime(new Date(openAlert.sent_at)) : 'just now'}
            </Label>
          </Row>
          <div className="text-md leading-snug font-bold break-words">{openAlert.reason}</div>
          <div className="text-xs text-muted-strong">
            Told to {openAlert.sent_to} by {openAlert.channel} · {openAlert.delivery_status}
          </div>
          <Row className="flex-col items-stretch gap-2 pt-0.5 sm:flex-row">
            <Button href={`tel:${patient.phone_e164}`} className="flex-1">
              Call {name} now
            </Button>
            <Button variant="outline" className="flex-1" href={`/alerts/${openAlert.id}`}>
              Open alert
            </Button>
          </Row>
          {openCount > 1 && (
            <Link to="/alerts" className="text-xs font-semibold underline">
              {openCount} open alerts ›
            </Link>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        <div className="flex flex-col gap-4">
          {/* ---------------------------------------------------------- next dose */}
          {meds.length === 0 ? (
            <EmptyBlock
              title="No medicines yet"
              body="Add a prescription and we build the schedule from it."
              action={<Button href="/setup/prescription">Add prescription</Button>}
            />
          ) : next ? (
            <Card emphasis="border" className="kv-rise gap-3" >
              <Row>
                <Label className="flex-1 text-accent">
                  Next dose · {next.isTomorrow ? 'tomorrow' : relativeTime(next.at)}
                </Label>
                <Tag tone="accent" outline className="tnum">
                  {next.slot}
                </Tag>
              </Row>
              <div className="font-display text-2xl leading-none font-semibold break-words sm:text-3xl">
                {next.medication.name}{' '}
                <span className="text-muted-strong">{next.medication.dose}</span>
                {next.medication.is_priority && (
                  <span className="ml-2 inline-block align-middle">
                    <Tag tone="accent">priority</Tag>
                  </span>
                )}
              </div>
              <div className="text-sm text-muted-strong">
                {next.medication.with_food === 'after'
                  ? 'After food'
                  : next.medication.with_food === 'before'
                    ? 'Before food'
                    : 'Any time'}
              </div>
              {/* "Mark taken" is gated, not wired: confirming a dose by hand is a write, and
                  the app only reads (api/hooks.ts is queries alone). A button that looks live
                  and does nothing is worse than one that says why it cannot run — so it stays
                  in place, warm and readable, with the reason beside it. */}
              <Row className="flex-wrap gap-2 pt-1">
                <Button disabled className="flex-1">
                  Mark taken
                </Button>
                <Button variant="outline" className="flex-1" href={`tel:${patient.phone_e164}`}>
                  Call {name}
                </Button>
              </Row>
              <span className="text-xs text-muted-strong">
                Marking a dose by hand needs the Care API. Until then, {name} confirming it on the
                call is what records it.
              </span>
              <Divider />
              <span className="text-xs text-muted-strong">
                We call {name} shortly after {next.slot} if it is still unconfirmed. Call buttons
                open your phone's dialler — nothing dials on its own.
              </span>
            </Card>
          ) : (
            <Card emphasis="border" className="kv-rise gap-2">
              <Row className="gap-2">
                <Dot kind="filled" tone="accent" />
                <Label>Today</Label>
              </Row>
              <div className="font-display text-2xl leading-tight font-semibold">
                Every dose is accounted for.
              </div>
            </Card>
          )}

          {/* ------------------------------------------------- today so far */}
          <Card className="kv-rise gap-3" >
            <Row className="flex-wrap gap-2">
              <Label className="flex-1">Today so far · since 6 AM</Label>
              {summary.data && (
                <Label className="tnum">
                  {summary.data.doses_confirmed}/{summary.data.doses_total} doses ·{' '}
                  {summary.data.calls} {summary.data.calls === 1 ? 'call' : 'calls'} ·{' '}
                  {summary.data.alerts} {summary.data.alerts === 1 ? 'alert' : 'alerts'}
                </Label>
              )}
            </Row>

            {summary.data?.items.length === 0 && (
              <p className="py-2 text-sm text-muted-strong">
                Nothing has happened yet today. The first dose call is still ahead.
              </p>
            )}

            <div className="flex flex-col">
              {summary.data?.items.map((item, i) => <SummaryRow key={`${item.at}:${i}`} item={item} />)}
            </div>
            <Link to="/calendar" className="text-xs font-semibold underline">
              Open calendar ›
            </Link>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          {/* ------------------------------------------------- last check-in call */}
          {lastCall && (
            <Card emphasis="rule" className="kv-rise gap-2.5">
              <Row>
                <Label className="flex-1 tnum">
                  Last check-in ·{' '}
                  {new Date(lastCall.started_at).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Label>
                <Link to={`/calls/${lastCall.id}`} className="text-xs font-semibold underline">
                  Transcript ›
                </Link>
              </Row>
              {lastCallObservation ? (
                <>
                  <blockquote
                    lang="hi"
                    className="text-md leading-relaxed font-semibold break-words"
                  >
                    “{lastCallObservation.text}”
                  </blockquote>
                  <Row className="gap-2">
                    <SeverityChip severity={lastCallObservation.severity} />
                    <span className="text-xs text-muted-strong">said on this call, word for word</span>
                  </Row>
                </>
              ) : (
                <div className="text-sm text-muted-strong">Nothing was flagged on this call.</div>
              )}
              {lastCallDoses.length > 0 && (
                <Row className="flex-wrap gap-2">
                  {lastCallDoses.map((d) => (
                    <Chip key={d.id}>
                      {meds.find((m) => m.id === d.medication_id)?.name ?? 'Medicine'} ·{' '}
                      {d.status === 'confirmed' ? 'confirmed' : d.status}
                    </Chip>
                  ))}
                </Row>
              )}
            </Card>
          )}

          {/* ------------------------------------------------- what she said (2e) */}
          <Card className="kv-rise gap-2">
            <Row>
              <Label className="flex-1">What she said this week</Label>
              <Label className="tnum">{saidThisWeek.length}</Label>
            </Row>
            {saidThisWeek[0] ? (
              <blockquote lang="hi" className="text-sm leading-relaxed font-semibold break-words">
                “{saidThisWeek[0].text}”
              </blockquote>
            ) : (
              <div className="text-sm text-muted-strong">Nothing flagged this week.</div>
            )}
            <Link to="/observations" className="text-xs font-semibold underline">
              View all ›
            </Link>
          </Card>

          {/* -------------------------------------------------------- care record */}
          <Card className="kv-rise gap-2.5" >
            <Row>
              <Label className="flex-1">Care record</Label>
              <Link to="/record" className="text-xs font-semibold text-accent hover:underline">
                Open
              </Link>
            </Row>
            <div className="text-sm">
              {meds.length} {meds.length === 1 ? 'medicine' : 'medicines'}
              {meds.some((m) => m.is_priority) && ' · 1 priority'}
            </div>
            <div className="text-xs text-muted-strong">
              {patient.allergies.length > 0
                ? `Allergies: ${patient.allergies.join(', ')}`
                : 'No allergies recorded'}
            </div>
            {patient.doctor_phone && (
              <Row>
                <span className="flex-1 text-xs text-muted-strong">{patient.doctor_name}</span>
                <a
                  href={`tel:${patient.doctor_phone}`}
                  className="rounded-full border border-line-strong bg-paper px-3 py-1.5 text-xs font-medium hover:border-ink"
                >
                  Call
                </a>
              </Row>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

/** One line of the day roll-up. Status carries a word and a shape, never colour alone. */
function SummaryRow({ item }: { item: DaySummaryItem }) {
  const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isAlert = item.kind === 'escalation'

  const body = (
    <Row className="items-start gap-3 py-1.5">
      <span className="tnum w-12 shrink-0 pt-px text-2xs font-bold tracking-wide text-muted">
        {time}
      </span>
      <span
        className={clsx(
          'relative z-10 flex w-4 shrink-0 justify-center self-stretch pt-2',
          'before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-line-strong',
          '[&>span]:relative [&>span]:outline-[3px] [&>span]:outline-surface',
        )}
      >
        {item.kind === 'dose' ? (
          <Dot
            kind={item.status === 'confirmed' ? 'filled' : item.status === 'deferred' ? 'empty' : 'hollow'}
            tone={
              item.status === 'confirmed'
                ? 'accent'
                : item.status === 'missed'
                  ? 'danger'
                  : item.status === 'no_answer'
                    ? 'warn'
                    : 'ink'
            }
          />
        ) : isAlert ? (
          <Dot kind="hollow" tone="danger" />
        ) : (
          <Dot kind="empty" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={clsx(
            'block text-sm leading-snug',
            isAlert && 'font-semibold text-danger',
          )}
        >
          {item.kind === 'observation' ? <>&ldquo;{item.text}&rdquo;</> : item.text}
        </span>
        {item.kind === 'dose' && item.status && (
          <span className="mt-0.5 block">
            <DoseStatusChip status={item.status} />
          </span>
        )}
      </span>
    </Row>
  )

  return item.href ? (
    <Link
      to={item.href}
      className="-mx-2 block rounded-lg px-2 transition-colors hover:bg-fill/50"
    >
      {body}
    </Link>
  ) : (
    body
  )
}

/** Skeleton in the final layout's shape — nothing shifts when the data lands. */
function HomeSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4" aria-busy="true">
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        <div className="flex flex-col gap-4">
          <Card emphasis="border" className="gap-3">
            <div className="kv-shimmer h-3 w-32 rounded-full" />
            <div className="kv-shimmer h-9 w-3/4 rounded-lg" />
            <div className="kv-shimmer h-3 w-24 rounded-full" />
            <div className="flex gap-2 pt-1">
              <div className="kv-shimmer h-11 flex-1 rounded-full" />
              <div className="kv-shimmer h-11 flex-1 rounded-full" />
            </div>
          </Card>
          <Card className="gap-3">
            <div className="kv-shimmer h-3 w-40 rounded-full" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 py-1">
                <div className="kv-shimmer h-3 w-10 rounded-full" />
                <div className="kv-shimmer size-2.5 rounded-full" />
                <div className="kv-shimmer h-3 flex-1 rounded-full" />
              </div>
            ))}
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card emphasis="rule" className="gap-3">
            <div className="kv-shimmer h-3 w-28 rounded-full" />
            <div className="kv-shimmer h-5 w-full rounded-lg" />
            <div className="kv-shimmer h-5 w-2/3 rounded-lg" />
          </Card>
          <Card className="gap-3">
            <div className="kv-shimmer h-3 w-24 rounded-full" />
            <div className="kv-shimmer h-3 w-1/2 rounded-full" />
          </Card>
        </div>
      </div>
    </div>
  )
}
