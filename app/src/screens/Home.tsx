import { Link } from 'react-router-dom'
import clsx from 'clsx'
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
  LoadingBlock,
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
 * Wireframe 1f / 2e — the tab the caregiver opens twenty times a day.
 *
 * Two jobs, in this order:
 *   1. the one dose that needs attention right now
 *   2. everything that has already happened today, so nothing has to be hunted for
 *
 * The day roll-up is derived on every read (never stored) and polls at LIVE_POLL_MS, which is
 * what makes the record visibly change on camera while a call is in progress.
 */
export default function Home() {
  const record = useCareRecord()
  const doses = useDoseHistory()
  const summary = useDaySummary()
  const observations = useObservations()
  const escalations = useEscalations()
  const calls = useCalls()

  if (record.isLoading || doses.isLoading) return <LoadingBlock rows={5} />
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 lg:grid lg:grid-cols-[1.4fr_1fr] lg:items-start lg:gap-4">
      <div className="flex flex-col gap-3">
        {/* ---------------------------------------------------------- next dose */}
        {meds.length === 0 ? (
          <EmptyBlock
            title="No medicines yet"
            body="Add a prescription and we build the schedule from it."
            action={<Button href="/setup/prescription">Add prescription</Button>}
          />
        ) : next ? (
          <Card emphasis="border" className="gap-2.5">
            <Row>
              <Label className="flex-1">
                Next dose · {next.isTomorrow ? 'tomorrow' : relativeTime(next.at)}
              </Label>
              <Tag outline>{next.slot}</Tag>
            </Row>
            <div className="text-[19px] leading-tight font-bold">
              {next.medication.name} {next.medication.dose}
              {next.medication.is_priority && (
                <span className="ml-2 align-middle">
                  <Tag>priority</Tag>
                </span>
              )}
            </div>
            <div className="text-[12px] text-muted-strong">
              {next.medication.with_food === 'after'
                ? 'After food'
                : next.medication.with_food === 'before'
                  ? 'Before food'
                  : 'Any time'}
            </div>
            <Row className="flex-wrap gap-2">
              <Button className="flex-1">Mark taken</Button>
              <Button variant="outline" className="flex-1">
                Call {name}
              </Button>
            </Row>
            <Button variant="outline">Schedule a call for this dose later</Button>
            <Divider />
            <Row>
              <span className="flex-1 text-[11px] text-muted-strong">
                We call {name} shortly after {next.slot} if it is still unconfirmed.
              </span>
            </Row>
          </Card>
        ) : (
          <Card emphasis="border">
            <Label>Today</Label>
            <div className="text-[15px] font-bold">Every dose is accounted for.</div>
          </Card>
        )}

        {/* ------------------------------------------------- today so far (1f) */}
        <Card className="gap-2.5">
          <Row>
            <Label className="flex-1">Today so far · since 6 AM</Label>
            {summary.data && (
              <Label>
                {summary.data.doses_confirmed}/{summary.data.doses_total} doses ·{' '}
                {summary.data.calls} {summary.data.calls === 1 ? 'call' : 'calls'} ·{' '}
                {summary.data.alerts} {summary.data.alerts === 1 ? 'alert' : 'alerts'}
              </Label>
            )}
          </Row>

          {summary.isLoading && <LoadingBlock rows={3} />}
          {summary.error && <ErrorBlock error={summary.error} onRetry={() => summary.refetch()} />}

          {summary.data?.items.length === 0 && (
            <p className="py-2 text-[12px] text-muted-strong">
              Nothing has happened yet today. The first dose call is still ahead.
            </p>
          )}

          {summary.data?.items.map((item, i) => <SummaryRow key={`${item.at}:${i}`} item={item} />)}
        </Card>
      </div>

      <div className="flex flex-col gap-3">
        {/* --------------------------------------------------------- needs you */}
        {openAlert && (
          <Card emphasis="border" className="gap-2">
            <Row>
              <Tag>{openAlert.level}</Tag>
              <Label className="ml-auto">
                {openAlert.sent_at ? relativeTime(new Date(openAlert.sent_at)) : 'just now'}
              </Label>
            </Row>
            <div className="text-[13px] leading-snug font-bold">{openAlert.reason}</div>
            <div className="text-[11px] text-muted-strong">
              Told to {openAlert.sent_to} by {openAlert.channel} · {openAlert.delivery_status}
            </div>
            <Row className="gap-2">
              <Button className="flex-1">Call {name} now</Button>
              <Button variant="outline" className="flex-1" href={`/alerts/${openAlert.id}`}>
                Open
              </Button>
            </Row>
          </Card>
        )}

        {/* ------------------------------------------------- last check-in call */}
        {lastCall && (
          <Card emphasis="rule" className="gap-2">
            <Row>
              <Label className="flex-1">
                Last check-in · {new Date(lastCall.started_at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </Label>
              <Chip>Transcript</Chip>
            </Row>
            {lastCallObservation ? (
              <>
                <div className="text-[13px] leading-relaxed font-semibold">
                  “{lastCallObservation.text}”
                </div>
                <Row>
                  <SeverityChip severity={lastCallObservation.severity} />
                  <span className="text-[11px] text-muted-strong">
                    said on this call, word for word
                  </span>
                </Row>
              </>
            ) : (
              <div className="text-[12px] text-muted-strong">Nothing was flagged on this call.</div>
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

        {/* -------------------------------------------------------- care record */}
        <Card className="gap-2">
          <Row>
            <Label className="flex-1">Care record</Label>
            <Link to="/record" className="text-[11px] font-semibold underline">
              Open
            </Link>
          </Row>
          <div className="text-[12px]">
            {meds.length} {meds.length === 1 ? 'medicine' : 'medicines'}
            {meds.some((m) => m.is_priority) && ' · 1 priority'}
          </div>
          <div className="text-[11px] text-muted-strong">
            {patient.allergies.length > 0
              ? `Allergies: ${patient.allergies.join(', ')}`
              : 'No allergies recorded'}
          </div>
          {patient.doctor_phone && (
            <Row>
              <span className="flex-1 text-[11px] text-muted-strong">{patient.doctor_name}</span>
              <a
                href={`tel:${patient.doctor_phone}`}
                className="rounded-full border border-line-strong bg-paper px-2.5 py-1 text-[11px]"
              >
                Call
              </a>
            </Row>
          )}
        </Card>
      </div>
    </div>
  )
}

/** One line of the day roll-up. Status carries a word, never colour alone. */
function SummaryRow({ item }: { item: DaySummaryItem }) {
  const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const body = (
    <Row className="items-start gap-2.5 py-0.5">
      <span className="w-11 shrink-0 pt-0.5 text-[10px] font-bold tracking-wide text-muted">
        {time}
      </span>
      <span className="pt-1">
        {item.kind === 'dose' ? (
          <Dot kind={item.status === 'confirmed' ? 'filled' : item.status === 'deferred' ? 'empty' : 'hollow'} />
        ) : item.kind === 'escalation' ? (
          <Dot kind="hollow" />
        ) : (
          <Dot kind="empty" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={clsx(
            'block text-[12px] leading-snug',
            item.kind === 'escalation' && 'font-semibold',
          )}
        >
          {item.text}
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
    <Link to={item.href} className="-mx-1 block rounded px-1 hover:bg-line/40">
      {body}
    </Link>
  ) : (
    body
  )
}
