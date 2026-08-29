import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Card,
  Chip,
  Divider,
  Dot,
  DoseStatusChip,
  EmptyBlock,
  ErrorBlock,
  Label,
  LoadingBlock,
  Row,
  Tag,
} from '../ui'
import { useCareRecord, useDoseHistory } from '../api/hooks'
import { slotsForDay } from '../lib/schedule'
import type { UpcomingDose } from '../lib/schedule'
import type { DoseStatus } from '../api/types'

/**
 * FR-25 · wireframe `1g` (phone: day timeline under a week strip) / `2f` (desktop: week grid,
 * time rows × seven day columns).
 *
 * Calendar is the SCHEDULE — every slot the prescription creates, whether or not anything has
 * been written against it yet. Dose history is the RECORD — one row per `dose_events` row.
 * That difference decides the shape: this screen is slot-shaped, so a slot with no event is a
 * first-class thing here (it reads "upcoming" / "no record yet") where in the history it simply
 * does not exist. Notes and call links stay on the history screen; duplicating them here would
 * make two screens that disagree.
 *
 * Slot expansion is `slotsForDay()` from lib/schedule — one implementation of "which medicines
 * are due when", shared with Home's next-dose card, so the two can never drift apart.
 *
 * The `2f` annotation asks for drag-to-reschedule. Deliberately not built: there is no mutation
 * endpoint behind it, and a control that appears to move a dose but silently does not is worse
 * for a caregiver than no control. Times are changed in the medicine editor, which the two
 * buttons at the foot go to.
 */

const STATUSES: DoseStatus[] = ['confirmed', 'deferred', 'missed', 'no_answer']

/** Said in words, because the four are exactly what a caregiver must not have to guess at. */
const MEANING: Record<DoseStatus, string> = {
  confirmed: 'Taken — confirmed on a check-in call.',
  deferred: 'Put off to a later time, and still expected.',
  missed: 'The dose was not taken.',
  no_answer: 'Nobody picked up. Whether the dose was taken is not known either way.',
}

/* ------------------------------------------------------------------ dates */

/** Local calendar day, never UTC — a 21:00 IST dose must not land on the previous day. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

/** Weeks run Monday → Sunday, as drawn in both frames. */
function startOfWeek(d: Date): Date {
  const copy = startOfDay(d)
  const shift = (copy.getDay() + 6) % 7
  return addDays(copy, -shift)
}

/** 'HH:MM' → '8:30 AM' in the reader's locale. */
function slotLabel(slot: string): string {
  const [h, m] = slot.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m ?? 0, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/* ------------------------------------------------------------------ slots */

interface SlotGroup {
  slot: string
  at: Date
  doses: UpcomingDose[]
}

/**
 * Two medicines at 08:30 are one row on the timeline, not two. Grouping only — the expansion
 * itself (medicines × slots, with the matching dose_event attached) is `slotsForDay`.
 */
function groupBySlot(doses: UpcomingDose[]): SlotGroup[] {
  const groups = new Map<string, SlotGroup>()
  for (const dose of doses) {
    const existing = groups.get(dose.slot)
    if (existing) existing.doses.push(dose)
    else groups.set(dose.slot, { slot: dose.slot, at: dose.at, doses: [dose] })
  }
  return [...groups.values()].sort((a, b) => a.at.getTime() - b.at.getTime())
}

interface DayTally {
  confirmed: number
  attention: number
  recorded: number
  total: number
}

/** Counted straight off the slots below it — nothing averaged, no percentage. */
function tally(doses: UpcomingDose[]): DayTally {
  return {
    confirmed: doses.filter((d) => d.event?.status === 'confirmed').length,
    attention: doses.filter((d) => d.event?.status === 'missed' || d.event?.status === 'no_answer')
      .length,
    recorded: doses.filter((d) => d.event !== null).length,
    total: doses.length,
  }
}

/* ------------------------------------------------------------------ screen */

export default function Calendar() {
  const record = useCareRecord()
  const doses = useDoseHistory()
  const [selected, setSelected] = useState<Date>(() => startOfDay(new Date()))

  if (record.isLoading || doses.isLoading) return <LoadingBlock rows={6} />
  if (record.error) return <ErrorBlock error={record.error} onRetry={() => record.refetch()} />
  /**
   * Without the dose events every past slot would draw as "upcoming", which a caregiver reads
   * as "nothing has gone wrong". Refusing to draw the screen is safer than under-reporting a
   * missed dose, so this is a full error state rather than a footnote.
   */
  if (doses.error) return <ErrorBlock error={doses.error} onRetry={() => doses.refetch()} />

  const medications = record.data?.medications ?? []
  const events = doses.data ?? []
  const name = record.data?.patient.name ?? 'your parent'

  const now = new Date()
  const today = startOfDay(now)
  const weekStart = startOfWeek(selected)
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const monthTitle = selected.toLocaleDateString([], { month: 'long', year: 'numeric' })

  if (medications.length === 0) {
    return (
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-3">
        <Header monthTitle={monthTitle} week={week} name={name} />
        <EmptyBlock
          title="Nothing is scheduled yet"
          body="The calendar is built from the prescription. Add one and every dose appears here, at the times it is due."
          action={
            <Link to="/medicines/edit" className={BTN_PRIMARY}>
              Upload a prescription
            </Link>
          }
        />
      </section>
    )
  }

  // One expansion per day of the week, reused by the strip, the timeline and the grid.
  const byDay = week.map((day) => slotsForDay(medications, events, day))
  const selectedIndex = Math.max(
    0,
    week.findIndex((d) => dayKey(d) === dayKey(selected)),
  )
  const dayDoses = byDay[selectedIndex] ?? []
  const timeline = groupBySlot(dayDoses)
  const dayTally = tally(dayDoses)

  // Every slot time in the prescription, ascending — the rows of the week grid ('HH:MM' sorts).
  const slotTimes = [...new Set(medications.flatMap((m) => m.slots))].sort()
  const bySlot = byDay.map((list) => {
    const map = new Map<string, UpcomingDose[]>()
    for (const dose of list) {
      const existing = map.get(dose.slot)
      if (existing) existing.push(dose)
      else map.set(dose.slot, [dose])
    }
    return map
  })

  // "so far this week" — only slots that have actually come due are counted as due.
  const weekDoses = byDay.flat()
  const weekDue = weekDoses.filter((d) => d.at.getTime() <= now.getTime())
  const weekConfirmed = weekDue.filter((d) => d.event?.status === 'confirmed').length

  // The next slot still waiting on an answer today — drawn emphasised, as in both frames.
  const nextPendingSlot =
    dayKey(selected) === dayKey(today)
      ? (timeline.find(
          (g) =>
            g.at.getTime() >= now.getTime() - 60_000 && g.doses.some((d) => d.event === null),
        )?.slot ?? null)
      : null

  const selectedHeading =
    dayKey(selected) === dayKey(today)
      ? 'Today'
      : dayKey(selected) === dayKey(addDays(today, -1))
        ? 'Yesterday'
        : dayKey(selected) === dayKey(addDays(today, 1))
          ? 'Tomorrow'
          : selected.toLocaleDateString([], { weekday: 'long' })

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-3">
      <Header monthTitle={monthTitle} week={week} name={name} />

      {/* --------------------------------------------------------- week nav */}
      <Row className="flex-wrap gap-1.5">
        <Chip onClick={() => setSelected(addDays(selected, -7))}>‹ Previous week</Chip>
        <Chip on={dayKey(selected) === dayKey(today)} onClick={() => setSelected(today)}>
          Today
        </Chip>
        <Chip onClick={() => setSelected(addDays(selected, 7))}>Next week ›</Chip>
        <span className="ml-auto text-sm text-muted-strong">
          {weekDue.length === 0
            ? 'nothing due yet this week'
            : `${weekConfirmed} of ${weekDue.length} confirmed so far this week`}
        </span>
      </Row>

      {/* ------------------------------------------------- week strip (1g) */}
      <Card className="gap-2 p-2">
        <div className="flex gap-1">
          {week.map((day, i) => (
            <DayChip
              key={dayKey(day)}
              day={day}
              today={today}
              now={now}
              selected={dayKey(day) === dayKey(selected)}
              tally={tally(byDay[i] ?? [])}
              onSelect={() => setSelected(day)}
            />
          ))}
        </div>
        <p className="px-1 text-2xs text-muted">
          Tap a day to see it below. The figure under each day counts confirmed doses out of the
          doses due that day.
        </p>
      </Card>

      {/* ------------------------------------------- day timeline (1g) — phone
          Shown on every width: on desktop it stays as the detail for the day picked
          out of the grid above it. */}
      <Card className="gap-2">
        <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-md font-bold">{selectedHeading}</span>
          <span className="text-sm text-muted-strong">
            {selected.toLocaleDateString([], { day: 'numeric', month: 'short' })}
          </span>
          {dayKey(selected) === dayKey(today) && <Tag outline>today</Tag>}
          <span className="ml-auto text-sm font-semibold">
            {dayTally.total === 0
              ? 'nothing scheduled'
              : dayTally.recorded === 0
                ? `${dayTally.total} ${dayTally.total === 1 ? 'dose' : 'doses'} scheduled`
                : `${dayTally.confirmed} of ${dayTally.total} confirmed`}
          </span>
        </Row>

        <Divider />

        {timeline.length === 0 ? (
          <p className="py-2 text-base text-muted-strong">
            No doses are scheduled on this day.
          </p>
        ) : (
          timeline.map((group, i) => (
            <div key={group.slot}>
              {i > 0 && <Divider />}
              <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 py-2">
                <span className="pt-2 text-2xs font-bold tracking-wide text-muted">
                  {slotLabel(group.slot)}
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  {group.doses.map((dose) => (
                    <Card
                      key={dose.medication.id + dose.slot}
                      className="gap-1 px-2.5 py-2"
                      emphasis={group.slot === nextPendingSlot ? 'border' : 'none'}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-md font-semibold">{dose.medication.name}</span>
                        <span className="text-base text-muted-strong">{dose.medication.dose}</span>
                        {dose.medication.is_priority && <Tag>priority</Tag>}
                        {group.slot === nextPendingSlot && <Tag outline>next</Tag>}
                        <span className="ml-auto shrink-0">
                          <SlotStatus dose={dose} now={now} />
                        </span>
                      </div>
                      {dose.medication.with_food && dose.medication.with_food !== 'any' && (
                        <div className="text-sm text-muted-strong">
                          {dose.medication.with_food === 'after' ? 'After food' : 'Before food'}
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}

        <div className="text-2xs text-muted">
          What was said on the call, and any note against a dose, is on the{' '}
          <Link to="/doses" className="font-semibold underline">
            dose history
          </Link>
          .
        </div>
      </Card>

      {/* --------------------------------------------- week grid (2f) — sm+
          Held back below `sm` and scrolled inside its own box above it, so the page
          itself never scrolls sideways on a 390px phone. */}
      <Card className="hidden gap-2 sm:flex">
        <Row className="items-baseline gap-2">
          <Label className="flex-1">The week · every dose at every time</Label>
          <span className="text-2xs text-muted">days already past are dimmed</span>
        </Row>

        <div className="-mx-1 overflow-x-auto px-1">
          <div className="min-w-[42rem]">
            {/* day columns */}
            <div className="grid grid-cols-[3.75rem_repeat(7,minmax(0,1fr))] gap-x-1.5 border-b border-line pb-2">
              <span />
              {week.map((day) => {
                const isToday = dayKey(day) === dayKey(today)
                const isPast = day.getTime() < today.getTime()
                return (
                  <button
                    key={dayKey(day)}
                    type="button"
                    onClick={() => setSelected(day)}
                    aria-pressed={dayKey(day) === dayKey(selected)}
                    className={clsx(
                      'rounded-lg px-1 py-1 text-center',
                      isToday && 'bg-ink text-white',
                      !isToday && isPast && 'text-muted-strong opacity-70',
                      !isToday && dayKey(day) === dayKey(selected) && 'border border-ink',
                    )}
                  >
                    <div
                      className={clsx(
                        'text-2xs font-bold tracking-[0.09em] uppercase',
                        isToday ? 'text-white/70' : 'text-muted',
                      )}
                    >
                      {day.toLocaleDateString([], { weekday: 'short' })}
                    </div>
                    <div className={clsx('text-md', isToday ? 'font-bold' : 'font-semibold')}>
                      {day.getDate()}
                    </div>
                  </button>
                )
              })}
            </div>

            {/* time rows */}
            {slotTimes.map((slot) => (
              <div
                key={slot}
                className="grid grid-cols-[3.75rem_repeat(7,minmax(0,1fr))] items-stretch gap-x-1.5 border-b border-line py-1.5"
              >
                <span className="pt-2 text-2xs font-bold tracking-wide text-muted">{slot}</span>
                {week.map((day, i) => {
                  const cell = bySlot[i]?.get(slot) ?? []
                  const isToday = dayKey(day) === dayKey(today)
                  const isPast = day.getTime() < today.getTime()
                  return (
                    <div
                      key={dayKey(day)}
                      className={clsx(
                        'rounded-md border p-1.5',
                        isToday ? 'border-[1.5px] border-ink bg-paper' : 'border-line-strong',
                        isPast && !isToday && 'opacity-70',
                      )}
                    >
                      {cell.length === 0 ? (
                        <span className="text-2xs text-muted">—</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {cell.map((dose) => (
                            <div key={dose.medication.id} className="flex flex-col gap-0.5">
                              <span className="truncate text-sm font-semibold">
                                {dose.medication.name}
                              </span>
                              <SlotStatus dose={dose} now={now} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        <p className="text-2xs text-muted">
          Doses are shown where the prescription puts them. To move a time, change the medicine —
          nothing on this grid can be dragged, because nothing here would save.
        </p>
      </Card>

      {/* ------------------------------------------------------------ legend */}
      <Card className="gap-2">
        <Label>What each mark means</Label>
        {STATUSES.map((status) => (
          <Row key={status} className="items-start gap-2">
            <span className="w-[6.75rem] shrink-0 pt-px">
              <DoseStatusChip status={status} />
            </span>
            <span className="min-w-0 flex-1 text-sm break-words text-muted-strong">
              {MEANING[status]}
            </span>
          </Row>
        ))}
        <Row className="items-start gap-2">
          <span className="w-[6.75rem] shrink-0 pt-px">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-strong">
              <Dot kind="empty" />
              upcoming
            </span>
          </span>
          <span className="min-w-0 flex-1 text-sm break-words text-muted-strong">
            Due, and nothing written against it yet. A slot in the past with no record reads “no
            record yet” — not missed, because nobody has said either way.
          </span>
        </Row>
      </Card>

      {/* --------------------------------------------------------- CTAs (1g)
          Both land on the same editor — one opens on the medicine list, the other on the
          uploader — exactly as the client redrew them. */}
      <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row">
        <Link to="/medicines/edit" className={clsx(BTN_PRIMARY, 'flex-1')}>
          Edit these medicines
        </Link>
        <Link to="/medicines/edit" className={clsx(BTN_OUTLINE, 'flex-1')}>
          Upload new prescription
        </Link>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ parts */

/** Same shape as the `Button` primitive, as a router link so the tab bar state survives. */
const BTN_BASE =
  'inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-center text-base font-semibold'
const BTN_PRIMARY = `${BTN_BASE} bg-ink text-white`
const BTN_OUTLINE = `${BTN_BASE} border border-ink bg-transparent text-ink`

function Header({
  monthTitle,
  week,
  name,
}: {
  monthTitle: string
  week: Date[]
  name: string
}) {
  const first = week[0]!
  const last = week[6]!
  const range = `${first.getDate()}–${last.getDate()} ${last.toLocaleDateString([], {
    month: 'short',
  })}`

  return (
    <div className="flex flex-col gap-1">
      <Row className="items-baseline gap-2">
        <h1 className="flex-1 text-lg font-bold">{monthTitle}</h1>
        <Label>{range}</Label>
      </Row>
      <p className="text-sm text-muted-strong">
        Every dose {name} is due to take, and how each one went. The times come from the
        prescription — change them in the medicine editor.
      </p>
    </div>
  )
}

/**
 * The status of one scheduled slot. A slot with no dose_event is NOT a missed dose: before its
 * time it is "upcoming", after it "no record yet" — the two things a caregiver can act on
 * differently. Anything that has been answered renders through `DoseStatusChip`, so the four
 * recorded states look the same here as everywhere else in the app.
 */
function SlotStatus({ dose, now }: { dose: UpcomingDose; now: Date }) {
  if (dose.event) return <DoseStatusChip status={dose.event.status} />
  const due = dose.at.getTime() <= now.getTime()
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-strong">
      <Dot kind="empty" />
      {due ? 'no record yet' : 'upcoming'}
    </span>
  )
}

/**
 * One day in the week strip. Carries how the day went as a count of doses plus a dot whose
 * shape (not colour) differs, and spells the same thing out in the accessible name.
 */
function DayChip({
  day,
  today,
  now,
  selected,
  tally: t,
  onSelect,
}: {
  day: Date
  today: Date
  now: Date
  selected: boolean
  tally: DayTally
  onSelect: () => void
}) {
  const isToday = dayKey(day) === dayKey(today)
  const isFuture = day.getTime() > today.getTime()
  const started = day.getTime() <= now.getTime()

  const summary =
    t.total === 0
      ? 'nothing scheduled'
      : !started
        ? `${t.total} ${t.total === 1 ? 'dose' : 'doses'} scheduled`
        : t.recorded === 0
          ? 'nothing recorded yet'
          : `${t.confirmed} of ${t.total} confirmed${
              t.attention > 0 ? `, ${t.attention} needing attention` : ''
            }`

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${day.toLocaleDateString([], {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })} — ${summary}`}
      className={clsx(
        'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1.5',
        selected && 'bg-ink text-white',
        !selected && isToday && 'border border-ink',
        !selected && isFuture && 'text-muted-strong',
      )}
    >
      <span
        className={clsx(
          'text-2xs font-bold tracking-[0.09em] uppercase',
          selected ? 'text-white/70' : 'text-muted',
        )}
      >
        {day.toLocaleDateString([], { weekday: 'narrow' })}
      </span>
      <span className={clsx('text-md', isToday ? 'font-bold' : 'font-semibold')}>
        {day.getDate()}
      </span>
      <span className="flex h-3 items-center gap-1">
        {t.total > 0 && started && (
          <>
            {/* the dot is dropped on the selected day: an ink dot on ink is invisible */}
            {!selected && (
              <Dot
                kind={
                  t.attention > 0
                    ? 'hollow'
                    : t.recorded > 0 && t.confirmed === t.total
                      ? 'filled'
                      : 'empty'
                }
              />
            )}
            <span className="text-2xs tabular-nums">
              {t.confirmed}/{t.total}
            </span>
          </>
        )}
      </span>
    </button>
  )
}
