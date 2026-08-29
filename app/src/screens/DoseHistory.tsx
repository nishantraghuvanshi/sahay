import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Card,
  Chip,
  Divider,
  DoseStatusChip,
  EmptyBlock,
  ErrorBlock,
  Label,
  LoadingBlock,
  Row,
  Tag,
} from '../ui'
import { useCareRecord, useDoseHistory } from '../api/hooks'
import { adherenceForDay } from '../lib/schedule'
import type { DoseEvent, DoseStatus, Medication } from '../api/types'

/**
 * FR-24 · wireframe `1g` (day timeline) / `2f` (week grid, borrowed for the desktop columns).
 *
 * The contract of this screen is that it reconciles with `dose_events`. Every number on it is
 * a count of rows that are visible directly beneath it — "2 of 3 confirmed" is
 * `adherenceForDay`, which is `filter(status === 'confirmed').length` over `filter(sameDay)`.
 * There is no percentage, no rolling average, no smoothing: a judge can open the table and
 * arrive at the same figure by counting. Notes are rendered whole and verbatim, because the
 * reason a dose was missed is the most useful sentence on the screen.
 */

type Filter = DoseStatus | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'missed', label: 'Missed' },
  { key: 'no_answer', label: 'No answer' },
  { key: 'unknown', label: 'Not known' },
  { key: 'deferred', label: 'Deferred' },
]

/**
 * `missed` is the only status that asserts the dose was not taken. `no_answer` and `unknown`
 * both mean we do not know, and must never be read as `missed` — one is "we called and nobody
 * picked up", the other "we could not reach them at all". Said in words on the row itself.
 */
const MEANING: Record<DoseStatus, string> = {
  confirmed: 'Taken — confirmed on a check-in call.',
  deferred: 'Put off to a later time, and still expected.',
  missed: 'The dose was not taken.',
  no_answer: 'Nobody picked up. Whether the dose was taken is not known either way.',
  unknown: 'We could not reach them at all. This is not a missed dose — nothing is known about it.',
}

/** Local calendar day, never UTC — a 21:00 IST dose must not land on the previous day. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

interface DayGroup {
  key: string
  day: Date
  events: DoseEvent[]
}

/** Newest day first; oldest slot first inside a day. Today is always present, even if empty. */
function groupByDay(events: DoseEvent[], today: Date): DayGroup[] {
  const groups = new Map<string, DayGroup>()
  groups.set(dayKey(today), { key: dayKey(today), day: today, events: [] })

  for (const event of events) {
    const at = new Date(event.slot_time)
    const key = dayKey(at)
    const existing = groups.get(key)
    if (existing) existing.events.push(event)
    else groups.set(key, { key, day: at, events: [event] })
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      events: [...g.events].sort((a, b) => a.slot_time.localeCompare(b.slot_time)),
    }))
    .sort((a, b) => b.key.localeCompare(a.key))
}

function dayHeading(day: Date, today: Date): string {
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayKey(day) === dayKey(today)) return 'Today'
  if (dayKey(day) === dayKey(yesterday)) return 'Yesterday'
  return day.toLocaleDateString([], { weekday: 'long' })
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export default function DoseHistory() {
  const doses = useDoseHistory()
  const record = useCareRecord()
  const [filter, setFilter] = useState<Filter>('all')

  if (doses.isLoading || record.isLoading) return <LoadingBlock rows={6} />
  if (doses.error) return <ErrorBlock error={doses.error} onRetry={() => doses.refetch()} />

  const events = doses.data ?? []
  const medications = record.data?.medications ?? []
  const medicationFor = (id: string): Medication | undefined => medications.find((m) => m.id === id)

  const today = new Date()
  const days = groupByDay(events, today)

  const count = (key: Filter) =>
    key === 'all' ? events.length : events.filter((e) => e.status === key).length

  const visible = days
    .map((g) => ({
      ...g,
      shown: filter === 'all' ? g.events : g.events.filter((e) => e.status === filter),
    }))
    .filter((g) => g.shown.length > 0 || (filter === 'all' && g.key === dayKey(today)))

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {/* ------------------------------------------------------------- header */}
      <div className="flex flex-col gap-1">
        <Row className="items-baseline gap-2">
          <h1 className="flex-1 text-[17px] font-bold">Dose history</h1>
          <Label>
            {events.length} {events.length === 1 ? 'record' : 'records'}
          </Label>
        </Row>
        <p className="text-[11px] text-muted-strong">
          One row per dose, exactly as it was written down. The counts are counts of these rows —
          nothing here is averaged or estimated.
        </p>
      </div>

      {record.error && (
        <p className="text-[11px] text-muted-strong">
          Medicine names could not be loaded just now. The doses below are unchanged.
        </p>
      )}

      {/* ------------------------------------------------------------ filters */}
      <Row className="flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Chip key={f.key} on={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} · {count(f.key)}
          </Chip>
        ))}
      </Row>

      {/* -------------------------------------------------------------- table */}
      {events.length === 0 ? (
        <EmptyBlock
          title="No doses recorded yet"
          body="The first check-in call has not happened yet. As soon as one does, every dose it covers appears here — taken, missed, deferred or unanswered."
        />
      ) : visible.length === 0 ? (
        <Card className="py-6 text-center">
          <div className="text-[12px] text-muted-strong">
            No doses with that status. {events.length} records in total.
          </div>
        </Card>
      ) : (
        visible.map((group) => {
          const day = adherenceForDay(events, group.day)
          const isToday = group.key === dayKey(today)

          return (
            <Card key={group.key} className="gap-2" emphasis={isToday ? 'border' : 'none'}>
              {/* day header — the count is read straight off the rows below it */}
              <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[13px] font-bold">{dayHeading(group.day, today)}</span>
                <span className="text-[11px] text-muted-strong">
                  {group.day.toLocaleDateString([], { day: 'numeric', month: 'short' })}
                </span>
                {isToday && <Tag outline>today</Tag>}
                <span className="ml-auto text-[11px] font-semibold">
                  {day.total === 0
                    ? 'nothing logged yet'
                    : `${day.confirmed} of ${day.total} confirmed`}
                </span>
              </Row>

              {group.shown.length > 0 && (
                <>
                  <Divider />
                  {/* column headings only where there is room for a table (wireframe 2f) */}
                  <div className="hidden grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 sm:grid">
                    <Label>Time</Label>
                    <Row>
                      <Label className="flex-1">Medicine</Label>
                      <Label className="w-[6.75rem]">Status</Label>
                    </Row>
                  </div>
                </>
              )}

              {group.shown.length === 0 ? (
                <p className="py-1 text-[12px] text-muted-strong">
                  Nothing has been logged today yet. The next check-in call will fill this in.
                </p>
              ) : (
                group.shown.map((event, i) => (
                  <div key={event.id}>
                    {i > 0 && <Divider />}
                    <DoseRow event={event} medication={medicationFor(event.medication_id)} />
                  </div>
                ))
              )}

              {filter !== 'all' && group.shown.length < group.events.length && (
                <div className="text-[10px] text-muted">
                  Showing {group.shown.length} of {group.events.length} rows for this day.
                </div>
              )}
            </Card>
          )
        })
      )}

      {/* ------------------------------------------------------------- legend */}
      {events.length > 0 && (
        <Card className="gap-2">
          <Label>What the four statuses mean</Label>
          {(['confirmed', 'deferred', 'missed', 'no_answer', 'unknown'] as DoseStatus[]).map((status) => (
            <Row key={status} className="items-start gap-2">
              <span className="w-[6.75rem] shrink-0 pt-px">
                <DoseStatusChip status={status} />
              </span>
              <span className="min-w-0 flex-1 text-[11px] break-words text-muted-strong">
                {MEANING[status]}
              </span>
            </Row>
          ))}
        </Card>
      )}
    </section>
  )
}

/**
 * One `dose_events` row. Time, medicine, status, and the note exactly as it was captured —
 * never shortened, never summarised, and it wraps rather than clipping. Rows written during a
 * call open that call.
 */
function DoseRow({ event, medication }: { event: DoseEvent; medication: Medication | undefined }) {
  const body = (
    <div className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 py-2.5 sm:py-2">
      <span className="pt-0.5 text-[10px] font-bold tracking-wide text-muted">
        {clock(event.slot_time)}
      </span>

      <div className="flex min-w-0 flex-col gap-1 sm:gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:flex-nowrap">
          <span className="text-[13px] font-semibold">{medication?.name ?? 'Medicine'}</span>
          {medication && <span className="text-[12px] text-muted-strong">{medication.dose}</span>}
          {medication?.is_priority && <Tag>priority</Tag>}
          <span className="ml-auto shrink-0 sm:w-[6.75rem]">
            <DoseStatusChip status={event.status} />
          </span>
        </div>

        {(event.status === 'missed' || event.status === 'no_answer' || event.status === 'unknown') && (
          <div
            className={clsx(
              'text-[11px] break-words',
              event.status === 'missed' ? 'font-semibold' : 'text-muted-strong',
            )}
          >
            {MEANING[event.status]}
          </div>
        )}

        {event.note && (
          <p className="border-l-2 border-line-strong pl-2 text-[12px] leading-relaxed break-words whitespace-pre-line">
            {event.note}
          </p>
        )}

        <div className="text-[10px] text-muted">
          logged {clock(event.created_at)}
          {event.call_session_id ? ' · on the call — open it' : ' · no call attached'}
        </div>
      </div>
    </div>
  )

  return event.call_session_id ? (
    <Link to={`/calls/${event.call_session_id}`} className="-mx-1 block rounded px-1 hover:bg-line/40">
      {body}
    </Link>
  ) : (
    body
  )
}
