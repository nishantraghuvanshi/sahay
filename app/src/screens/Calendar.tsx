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
import { useCareRecord, useDoseHistory, useEscalations } from '../api/hooks'
import { slotsForDay } from '../lib/schedule'
import type { UpcomingDose } from '../lib/schedule'
import type { DoseStatus, Escalation } from '../api/types'

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

/**
 * How close a slot has to be before it counts as happening *now*.
 *
 * 45 minutes, the same window the design doc (§5.2) uses to collapse nearby doses
 * into one call — if two doses would be called about together they are the same
 * moment as far as the patient is concerned. Bounded on both sides deliberately:
 * without an upper bound the chip lands on the next unanswered slot whenever it is,
 * so a dose six hours away would be labelled "now".
 */
const NOW_WINDOW_MS = 45 * 60_000

/**
 * The four views frame `2f` puts in the header.
 *
 * All four read the same expansion — `slotsForDay` — so they cannot disagree about
 * which medicines are due when. They differ only in how much time is on screen at
 * once: a day to act on, a week to check, a month to see a pattern, an agenda to
 * read straight through or hand to a doctor.
 */
type View = 'day' | 'week' | 'month' | 'agenda'

const VIEWS: { key: View; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'agenda', label: 'Agenda' },
]

const STEP_LABEL: Record<View, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Week',
}

/** Move by one screenful of whatever is on screen, not by a fixed week. */
function step(from: Date, view: View, direction: 1 | -1): Date {
  if (view === 'day') return addDays(from, direction)
  if (view === 'month') {
    const d = new Date(from)
    d.setMonth(d.getMonth() + direction, 1)
    return startOfDay(d)
  }
  return addDays(from, 7 * direction)
}

/** Every day of the month `d` falls in, padded to whole Monday-start weeks. */
function monthGrid(d: Date): Date[] {
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  const start = startOfWeek(first)
  const days: Date[] = []
  for (let cur = start; cur <= last || days.length % 7 !== 0; cur = addDays(cur, 1)) {
    days.push(cur)
    if (days.length > 41) break
  }
  return days
}

const STATUSES: DoseStatus[] = ['confirmed', 'deferred', 'missed', 'no_answer', 'unknown']

/** Said in words, because the four are exactly what a caregiver must not have to guess at. */
const MEANING: Record<DoseStatus, string> = {
  confirmed: 'Taken — confirmed on a check-in call.',
  deferred: 'Put off to a later time, and still expected.',
  missed: 'The dose was not taken.',
  no_answer: 'Nobody picked up. Whether the dose was taken is not known either way.',
  unknown: 'We could not reach them at all. This is not a missed dose — nothing is known about it.',
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
    attention: doses.filter(
      (d) =>
        d.event?.status === 'missed' ||
        d.event?.status === 'no_answer' ||
        d.event?.status === 'unknown',
    )
      .length,
    recorded: doses.filter((d) => d.event !== null).length,
    total: doses.length,
  }
}

/* ------------------------------------------------------------------ screen */

export default function Calendar() {
  const record = useCareRecord()
  const doses = useDoseHistory()
  // Only used to name the alert beside a dose that could not be established.
  // A failure here must not blank the calendar, so it is read without an error gate.
  const escalations = useEscalations()
  const [selected, setSelected] = useState<Date>(() => startOfDay(new Date()))
  const [view, setView] = useState<View>('week')

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
  const patient = record.data?.patient
  const name = patient?.name ?? 'your parent'

  /**
   * The intro call (FR-5) — a one-off consent call, not a dose. It belongs on this
   * screen because it is the first thing that will actually ring, and because until
   * it is done no dose call may be placed at all: a schedule can be signed off and
   * still be entirely dormant, which is invisible if the calendar only draws doses.
   */
  const escalationForDose = new Map<string, Escalation>(
    (escalations.data ?? [])
      .filter((e): e is Escalation & { dose_event_id: string } => Boolean(e.dose_event_id))
      .map((e) => [e.dose_event_id, e]),
  )

  const introAt = patient?.intro_call_at ? new Date(patient.intro_call_at) : null
  const introPending = patient?.intro_call_status === 'pending'
  const introOnSelected = introAt && dayKey(introAt) === dayKey(selected) ? introAt : null

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
  /**
   * The slot happening right now — frame `1g` gives it a `now` chip and a heavier
   * border. "Now" rather than "next" is the distinction the frame draws: it is the
   * dose currently due and still unanswered, not simply the one that comes after
   * this. Only ever set on today.
   */
  const nowSlot =
    dayKey(selected) === dayKey(today)
      ? (timeline.find(
          (g) =>
            g.at.getTime() >= now.getTime() - 60_000 &&
            g.at.getTime() <= now.getTime() + NOW_WINDOW_MS &&
            g.doses.some((d) => d.event === null),
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

      {/* ------------------------------------------------- view + range (2f) */}
      <Row className="flex-wrap gap-1.5 print:hidden">
        {VIEWS.map((v) => (
          <Chip key={v.key} on={view === v.key} onClick={() => setView(v.key)}>
            {v.label}
          </Chip>
        ))}
        <span className="ml-auto text-[11px] text-muted-strong">
          {weekDue.length === 0
            ? 'nothing due yet this week'
            : `${weekConfirmed} of ${weekDue.length} confirmed so far this week`}
        </span>
      </Row>

      {/* The step is whatever the current view shows, so a press always moves the
          page by exactly one screenful rather than by a fixed week. */}
      <Row className="flex-wrap gap-1.5 print:hidden">
        <Chip onClick={() => setSelected(step(selected, view, -1))}>‹ {STEP_LABEL[view]}</Chip>
        <Chip on={dayKey(selected) === dayKey(today)} onClick={() => setSelected(today)}>
          Today
        </Chip>
        <Chip onClick={() => setSelected(step(selected, view, 1))}>{STEP_LABEL[view]} ›</Chip>
        <Link to="/medicines/edit" className="ml-auto">
          <Chip>+ Add dose</Chip>
        </Link>
      </Row>

      {/* The gate, said plainly. A caregiver looking at a full week of doses has no
          other way to tell that none of them will be dialled yet. */}
      {introPending && (
        <Card emphasis="rule">
          <Row className="flex-wrap items-baseline gap-x-2">
            <Tag outline>intro call</Tag>
            <span className="text-[12px] font-semibold">
              {introAt
                ? `We call ${name} on ${introAt.toLocaleDateString([], {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short',
                  })} at ${introAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : `We still need to call ${name} to introduce ourselves`}
            </span>
          </Row>
          <span className="text-[11px] leading-relaxed text-muted-strong">
            Dose reminders do not begin until that call has happened and {name} has agreed on it.
            The doses below are scheduled, not yet being called about.
          </span>
        </Card>
      )}

      {/* ------------------------------------------------- week strip (1g) */}
      {(view === 'day' || view === 'week') && (
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
        <p className="px-1 text-[10px] text-muted">
          Tap a day to see it below. The figure under each day counts confirmed doses out of the
          doses due that day.
        </p>
      </Card>
      )}

      {/* ----------------------------------------------------- month (2f) */}
      {view === 'month' && (
        <Card className="gap-2 p-2">
          <div className="grid grid-cols-7 gap-1">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className="px-1 text-center text-[9.5px] text-muted">
                {d}
              </span>
            ))}
            {monthGrid(selected).map((day) => {
              const dayTally2 = tally(slotsForDay(medications, events, day))
              const outside = day.getMonth() !== selected.getMonth()
              return (
                <button
                  key={dayKey(day)}
                  type="button"
                  onClick={() => setSelected(day)}
                  aria-label={day.toDateString()}
                  className={clsx(
                    'flex min-h-[3.1rem] flex-col items-start gap-0.5 rounded-md border px-1.5 py-1 text-left',
                    dayKey(day) === dayKey(selected)
                      ? 'border-ink bg-paper'
                      : 'border-line bg-transparent',
                    outside && 'opacity-35',
                  )}
                >
                  <span
                    className={clsx(
                      'text-[11px]',
                      dayKey(day) === dayKey(today) ? 'font-bold' : 'text-muted-strong',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  {dayTally2.total > 0 && (
                    <span className="text-[9.5px] text-muted">
                      {dayTally2.recorded === 0
                        ? `${dayTally2.total} due`
                        : `${dayTally2.confirmed}/${dayTally2.total}`}
                    </span>
                  )}
                  {dayTally2.attention > 0 && (
                    <span className="text-[9.5px] font-semibold">
                      {dayTally2.attention} to check
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="px-1 text-[10px] text-muted">
            Each day shows confirmed out of due. Tap one to read it below.
          </p>
        </Card>
      )}

      {/* ---------------------------------------------------- agenda (2f)
          The whole week read straight through, which is the form that prints and the
          form you hand to a doctor. */}
      {view === 'agenda' && (
        <Card className="gap-2">
          <Label>The week, in order</Label>
          {week.map((day, i) => {
            const list = byDay[i] ?? []
            return (
              <div key={dayKey(day)} className="flex flex-col gap-1">
                <Divider />
                <Row className="flex-wrap items-baseline gap-x-2">
                  <span className="text-[12px] font-bold">
                    {day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}
                  </span>
                  {dayKey(day) === dayKey(today) && <Tag outline>today</Tag>}
                  <span className="ml-auto text-[10.5px] text-muted">
                    {list.length === 0 ? 'nothing scheduled' : `${list.length} doses`}
                  </span>
                </Row>
                {list.map((dose) => (
                  <Row key={dose.medication.id + dose.slot} className="items-baseline gap-2">
                    <span className="w-[3.25rem] shrink-0 text-[10px] font-bold text-muted">
                      {slotLabel(dose.slot)}
                    </span>
                    <span className="min-w-0 flex-1 text-[12px]">
                      {dose.medication.name}{' '}
                      <span className="text-muted-strong">{dose.medication.dose}</span>
                    </span>
                    <SlotStatus dose={dose} now={now} />
                  </Row>
                ))}
              </div>
            )
          })}
        </Card>
      )}

      {/* ------------------------------------------- day timeline (1g) — phone
          Shown on every width: on desktop it stays as the detail for the day picked
          out of the grid above it. */}
      {view !== 'agenda' && (
      <Card className="gap-2">
        <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13px] font-bold">{selectedHeading}</span>
          <span className="text-[11px] text-muted-strong">
            {selected.toLocaleDateString([], { day: 'numeric', month: 'short' })}
          </span>
          {dayKey(selected) === dayKey(today) && <Tag outline>today</Tag>}
          <span className="ml-auto text-[11px] font-semibold">
            {dayTally.total === 0
              ? 'nothing scheduled'
              : dayTally.recorded === 0
                ? `${dayTally.total} ${dayTally.total === 1 ? 'dose' : 'doses'} scheduled`
                : `${dayTally.confirmed} of ${dayTally.total} confirmed`}
          </span>
        </Row>

        <Divider />

        {introOnSelected && (
          <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 py-2">
            <span className="pt-2 text-[10px] font-bold tracking-wide text-muted">
              {introOnSelected.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            {/* Deliberately not styled as a dose card: this is a different kind of
                event and reading it as a medicine would be worse than not showing it. */}
            <Card className="gap-1 border-dashed px-2.5 py-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[13px] font-semibold">Introduction call</span>
                <Tag outline>not a dose</Tag>
                <span className="ml-auto shrink-0 text-[11px] text-muted-strong">
                  {patient?.intro_call_status === 'done' ? 'done' : 'scheduled'}
                </span>
              </div>
              <div className="text-[11px] text-muted-strong">
                We introduce ourselves to {name} and ask if these calls are welcome. No medicines
                are discussed.
              </div>
            </Card>
          </div>
        )}

        {timeline.length === 0 ? (
          <p className="py-2 text-[12px] text-muted-strong">
            {introOnSelected
              ? 'No doses are scheduled on this day — only the introduction call above.'
              : 'No doses are scheduled on this day.'}
          </p>
        ) : (
          timeline.map((group, i) => (
            <div key={group.slot}>
              {i > 0 && <Divider />}
              <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 py-2">
                <span className="pt-2 text-[10px] font-bold tracking-wide text-muted">
                  {slotLabel(group.slot)}
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  {group.doses.map((dose) => (
                    <Card
                      key={dose.medication.id + dose.slot}
                      className="gap-1 px-2.5 py-2"
                      emphasis={
                        dose.event?.status === 'unknown'
                          ? 'rule'
                          : group.slot === nowSlot
                            ? 'border'
                            : 'none'
                      }
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-[13px] font-semibold">{dose.medication.name}</span>
                        <span className="text-[12px] text-muted-strong">{dose.medication.dose}</span>
                        {dose.medication.is_priority && <Tag>priority</Tag>}
                        {group.slot === nowSlot && <Tag outline>now</Tag>}
                        <span className="ml-auto shrink-0">
                          <SlotStatus dose={dose} now={now} />
                        </span>
                      </div>
                      {dose.medication.with_food && dose.medication.with_food !== 'any' && (
                        <div className="text-[11px] text-muted-strong">
                          {dose.medication.with_food === 'after' ? 'After food' : 'Before food'}
                        </div>
                      )}
                      {dose.event?.status === 'unknown' && (
                        <Unreachable
                          note={dose.event.note}
                          escalation={escalationForDose.get(dose.event.id) ?? null}
                          name={name}
                          phone={patient?.phone_e164 ?? null}
                        />
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}

        <div className="text-[10px] text-muted">
          What was said on the call, and any note against a dose, is on the{' '}
          <Link to="/doses" className="font-semibold underline">
            dose history
          </Link>
          .
        </div>
      </Card>
      )}

      {/* --------------------------------------------- week grid (2f) — sm+
          Held back below `sm` and scrolled inside its own box above it, so the page
          itself never scrolls sideways on a 390px phone. */}
      {view === 'week' && (
      <Card className="hidden gap-2 sm:flex">
        <Row className="items-baseline gap-2">
          <Label className="flex-1">The week · every dose at every time</Label>
          <span className="text-[10px] text-muted">days already past are dimmed</span>
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
                        'text-[9px] font-bold tracking-[0.09em] uppercase',
                        isToday ? 'text-white/70' : 'text-muted',
                      )}
                    >
                      {day.toLocaleDateString([], { weekday: 'short' })}
                    </div>
                    <div className={clsx('text-[13px]', isToday ? 'font-bold' : 'font-semibold')}>
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
                <span className="pt-2 text-[10px] font-bold tracking-wide text-muted">{slot}</span>
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
                        <span className="text-[10px] text-muted">—</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {cell.map((dose) => (
                            <div key={dose.medication.id} className="flex flex-col gap-0.5">
                              <span className="truncate text-[11px] font-semibold">
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

        <p className="text-[10px] text-muted">
          Doses are shown where the prescription puts them. To move a time, change the medicine —
          nothing on this grid can be dragged, because nothing here would save.
        </p>
      </Card>
      )}

      {/* ------------------------------------------------------------ legend */}
      <Card className="gap-2">
        <Label>What each mark means</Label>
        {STATUSES.map((status) => (
          <Row key={status} className="items-start gap-2">
            <span className="w-[6.75rem] shrink-0 pt-px">
              <DoseStatusChip status={status} />
            </span>
            <span className="min-w-0 flex-1 text-[11px] break-words text-muted-strong">
              {MEANING[status]}
            </span>
          </Row>
        ))}
        <Row className="items-start gap-2">
          <span className="w-[6.75rem] shrink-0 pt-px">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-strong">
              <Dot kind="empty" />
              upcoming
            </span>
          </span>
          <span className="min-w-0 flex-1 text-[11px] break-words text-muted-strong">
            Due, and nothing written against it yet. A slot in the past with no record reads “no
            record yet” — not missed, because nobody has said either way.
          </span>
        </Row>
      </Card>

      {/* --------------------------------------------------------- CTAs (1g)
          Both land on the same editor — one opens on the medicine list, the other on the
          uploader — exactly as the client redrew them. */}
      <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row print:hidden">
        <Link to="/medicines/edit" className={clsx(BTN_PRIMARY, 'flex-1')}>
          Edit these medicines
        </Link>
        <Link to="/medicines/edit" className={clsx(BTN_OUTLINE, 'flex-1')}>
          Upload new prescription
        </Link>
        {/* Frame `2f`. The browser's own print dialog is also the share sheet and the
            save-as-PDF on every platform this runs on, so there is nothing to build
            behind it — and a schedule a caregiver can hand to a doctor on paper is
            the most useful thing this screen produces. Agenda prints best, so the
            button switches to it first rather than printing whatever happens to be
            on screen. */}
        <button
          type="button"
          onClick={() => {
            setView('agenda')
            requestAnimationFrame(() => window.print())
          }}
          className={clsx(BTN_OUTLINE, 'flex-1')}
        >
          Print / share PDF
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ parts */

/** Same shape as the `Button` primitive, as a router link so the tab bar state survives. */
const BTN_BASE =
  'inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-center text-[12px] font-semibold'
const BTN_PRIMARY = `${BTN_BASE} bg-ink text-white`
const BTN_SMALL =
  'inline-flex items-center rounded-md border border-ink px-2 py-1 text-[10.5px] font-semibold'
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
        <h1 className="flex-1 text-[17px] font-bold">{monthTitle}</h1>
        <Label>{range}</Label>
      </Row>
      <p className="text-[11px] text-muted-strong">
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
/**
 * What a caregiver is shown when a dose could not be established.
 *
 * The point of this block is that it never says the dose was missed. It says we
 * could not reach the parent, names the alert that fired if one did, and hands over
 * the three things a person can actually do about it.
 *
 * Two of those three are disabled, and visibly so. `medications`/`escalation_contacts`
 * hold no second number and no neighbour (SCHEMA-GAPS §5), and a button that looks
 * dialable but silently does nothing is worse than one that says why it cannot.
 */
function Unreachable({
  note,
  escalation,
  name,
  phone,
}: {
  note: string | null
  escalation: Escalation | null
  name: string
  phone: string | null
}) {
  return (
    <div className="mt-1 flex flex-col gap-1.5 border-t border-line pt-1.5">
      <span className="text-[11px] leading-relaxed text-muted-strong">
        We could not reach {name} for this dose, so whether it was taken is not known. It is
        not recorded as missed.
      </span>
      {note && <span className="text-[10.5px] text-muted">{note}</span>}
      {escalation && (
        <Row className="flex-wrap gap-1.5">
          <Tag outline>{escalation.level}</Tag>
          <span className="flex-1 text-[10.5px] text-muted-strong">
            Alert sent to {escalation.sent_to} — {escalation.reason}
          </span>
        </Row>
      )}
      <Row className="flex-wrap gap-1.5">
        {phone ? (
          <a href={`tel:${phone}`} className={BTN_SMALL}>
            Call {name} yourself
          </a>
        ) : (
          <span className={clsx(BTN_SMALL, 'opacity-40')}>No number on file</span>
        )}
        <span className={clsx(BTN_SMALL, 'opacity-40')} title="No second number is stored yet">
          Try another number
        </span>
        <span className={clsx(BTN_SMALL, 'opacity-40')} title="No neighbour contact is stored yet">
          Ask a neighbour
        </span>
      </Row>
      <span className="text-[10px] text-muted">
        The other two need a second contact number, which onboarding does not collect yet.
      </span>
    </div>
  )
}

/** Same short clock the dose history uses, so the two screens read alike. */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function SlotStatus({ dose, now }: { dose: UpcomingDose; now: Date }) {
  if (dose.event) {
    /**
     * Frame `1g`: a taken dose shows when it was confirmed, not just that it was.
     * The time is `created_at` — the moment it was logged — which is deliberately
     * not the slot: a dose due at 08:30 and confirmed at 09:10 was still late, and
     * printing the slot time back would hide that.
     */
    const at = dose.event.status === 'confirmed' ? clock(dose.event.created_at) : null
    return (
      <span className="inline-flex items-center gap-1.5">
        <DoseStatusChip status={dose.event.status} />
        {at && <span className="text-[10.5px] text-muted">{at}</span>}
      </span>
    )
  }
  const due = dose.at.getTime() <= now.getTime()
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-strong">
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
          'text-[9px] font-bold tracking-[0.09em] uppercase',
          selected ? 'text-white/70' : 'text-muted',
        )}
      >
        {day.toLocaleDateString([], { weekday: 'narrow' })}
      </span>
      <span className={clsx('text-[13px]', isToday ? 'font-bold' : 'font-semibold')}>
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
            <span className="text-[9px] tabular-nums">
              {t.confirmed}/{t.total}
            </span>
          </>
        )}
      </span>
    </button>
  )
}
