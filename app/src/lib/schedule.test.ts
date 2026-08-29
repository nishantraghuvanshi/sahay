import { describe, expect, it } from 'vitest'
import { slotsForDay } from './schedule'
import type { DoseEvent, Medication } from '../api/types'

const MED: Medication = {
  id: 'm1', patient_id: 'p1', name: 'Metformin', dose: '500mg',
  slots: ['08:30', '21:00'], with_food: 'after', is_priority: false, stock_count: null,
}

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d)
const atLocal = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).toISOString()

const moved = (from: string, to: string): DoseEvent => ({
  id: 'e1', patient_id: 'p1', medication_id: 'm1', slot_time: from, rescheduled_to: to,
  call_session_id: null, status: 'deferred', note: null, created_at: from,
})

describe('a rescheduled occurrence', () => {
  it('is drawn at its new time and not at the old one', () => {
    const events = [moved(atLocal(2026, 9, 1, 8, 30), atLocal(2026, 9, 1, 10, 0))]
    const slots = slotsForDay([MED], events, day(2026, 9, 1))

    const times = slots.map((s) => s.slot)
    expect(times).toContain('10:00')
    expect(times).not.toContain('08:30')
    // 21:00 is untouched — moving one occurrence must not disturb the others.
    expect(times).toContain('21:00')
  })

  it('is never drawn twice', () => {
    // Drawing it at both times would also make the count of what is due wrong.
    const events = [moved(atLocal(2026, 9, 1, 8, 30), atLocal(2026, 9, 1, 10, 0))]
    const slots = slotsForDay([MED], events, day(2026, 9, 1))
    expect(slots).toHaveLength(2)
  })

  it('moves across days, leaving the day it came from', () => {
    const events = [moved(atLocal(2026, 9, 1, 8, 30), atLocal(2026, 9, 2, 9, 0))]

    const first = slotsForDay([MED], events, day(2026, 9, 1)).map((s) => s.slot)
    expect(first).toEqual(['21:00'])

    const second = slotsForDay([MED], events, day(2026, 9, 2)).map((s) => s.slot)
    expect(second).toContain('09:00')
    expect(second).toHaveLength(3) // its own two, plus the one that arrived
  })

  it('carries its event across, so the move is visible on the row', () => {
    const events = [moved(atLocal(2026, 9, 1, 8, 30), atLocal(2026, 9, 1, 10, 0))]
    const arrived = slotsForDay([MED], events, day(2026, 9, 1)).find((s) => s.slot === '10:00')
    expect(arrived?.event?.status).toBe('deferred')
  })

  it('leaves ordinary days alone', () => {
    const slots = slotsForDay([MED], [], day(2026, 9, 1))
    expect(slots.map((s) => s.slot)).toEqual(['08:30', '21:00'])
  })
})
