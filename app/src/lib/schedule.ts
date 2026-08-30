import type { DoseEvent, Medication } from '../api/types'

/**
 * Pure schedule maths. No React, no fetching — so it can be reasoned about and tested
 * at a fixed instant. Every function that needs the clock takes `now`.
 *
 * Slots are LOCAL 'HH:MM' strings. Dates are always built with setHours, never by
 * concatenating an ISO string, which would silently reinterpret the time as UTC and
 * shift every dose by the timezone offset.
 */

export interface UpcomingDose {
  medication: Medication
  slot: string
  at: Date
  event: DoseEvent | null
  isTomorrow: boolean
}

function atLocal(day: Date, slot: string): Date {
  const [h, m] = slot.split(':').map(Number)
  const d = new Date(day)
  d.setHours(h, m ?? 0, 0, 0)
  return d
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/** Local 'HH:MM' for a Date — the same shape `medications.slots` uses. */
const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** The dose_event written for this exact medicine + slot, if the agent has logged one. */
function eventFor(events: DoseEvent[], medicationId: string, at: Date): DoseEvent | null {
  return (
    events.find((e) => {
      if (e.medication_id !== medicationId) return false
      const t = new Date(e.slot_time)
      return sameDay(t, at) && t.getHours() === at.getHours() && t.getMinutes() === at.getMinutes()
    }) ?? null
  )
}

/**
 * Every slot of every medicine expanded onto one day, in time order.
 *
 * A single occurrence can have been moved (`dose_events.rescheduled_to`), which the
 * recurring `medications.slots` cannot express. So the day is built in two passes:
 * the recurring occurrences that are still where the prescription puts them, and
 * then any occurrence moved *into* this day from another. An occurrence moved away
 * is dropped from its original day rather than drawn twice — otherwise a dose the
 * caregiver moved would appear at both times, and the count of what is due would be
 * wrong on both days.
 */
export function slotsForDay(
  medications: Medication[],
  events: DoseEvent[],
  day: Date,
): UpcomingDose[] {
  const today = new Date()
  const out: UpcomingDose[] = []

  for (const medication of medications) {
    for (const slot of medication.slots) {
      const at = atLocal(day, slot)
      const event = eventFor(events, medication.id, at)
      // Moved off this slot; it is drawn at its new time by the pass below.
      if (event?.rescheduled_to) continue
      out.push({ medication, slot, at, event, isTomorrow: !sameDay(at, today) })
    }
  }

  for (const event of events) {
    if (!event.rescheduled_to) continue
    const at = new Date(event.rescheduled_to)
    if (!sameDay(at, day)) continue
    const medication = medications.find((m) => m.id === event.medication_id)
    if (!medication) continue
    out.push({ medication, slot: hhmm(at), at, event, isTomorrow: !sameDay(at, today) })
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/**
 * The next slot still waiting on an answer.
 *
 * A slot that already has any dose_event against it — including `unknown` — is deliberately
 * NOT "next": it is history, and the alerts feed owns it. Surfacing it here would make the
 * home card show a dose the caregiver can no longer do anything about, in the position
 * reserved for the one they can. `unknown` counts as settled for this purpose even though
 * nothing is known about the dose: the slot has been attempted and will not be retried.
 */
export function nextDose(
  medications: Medication[],
  events: DoseEvent[],
  now: Date = new Date(),
): UpcomingDose | null {
  const settled = (d: UpcomingDose) =>
    d.event?.status === 'confirmed' ||
    d.event?.status === 'deferred' ||
    d.event?.status === 'missed' ||
    d.event?.status === 'no_answer' ||
    d.event?.status === 'unknown'

  const today = slotsForDay(medications, events, now).filter((d) => !settled(d))
  const ahead = today.find((d) => d.at.getTime() >= now.getTime() - 60_000)
  if (ahead) return ahead

  // Everything today is answered (or long past) — look at the first slot tomorrow.
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const first = slotsForDay(medications, events, tomorrow)[0]
  return first ? { ...first, isTomorrow: true } : null
}

/** 'now' · 'in 22 min' · 'in 3 h 10 min' · '2 h ago' — short enough for a card. */
export function relativeTime(target: Date, now: Date = new Date()): string {
  const diffMin = Math.round((target.getTime() - now.getTime()) / 60_000)
  if (Math.abs(diffMin) < 1) return 'now'

  const abs = Math.abs(diffMin)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  const span = h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`
  return diffMin > 0 ? `in ${span}` : `${span} ago`
}

/** Confirmed vs total for a day, counted straight from rows — nothing smoothed or estimated. */
export function adherenceForDay(
  events: DoseEvent[],
  day: Date,
): { confirmed: number; total: number } {
  const onDay = events.filter((e) => sameDay(new Date(e.slot_time), day))
  return {
    confirmed: onDay.filter((e) => e.status === 'confirmed').length,
    total: onDay.length,
  }
}

/** Oldest first, so it reads left-to-right as a sparkline. */
export function adherenceTrend(
  events: DoseEvent[],
  days: number,
  now: Date = new Date(),
): { day: Date; confirmed: number; total: number }[] {
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(now)
    day.setDate(day.getDate() - (days - 1 - i))
    return { day, ...adherenceForDay(events, day) }
  })
}

