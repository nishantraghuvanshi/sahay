import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import Calendar from './Calendar'
import type { CareRecord, DoseEvent, Escalation } from '../api/types'

vi.mock('../api/hooks', () => ({
  useCareRecord: vi.fn(),
  useDoseHistory: vi.fn(),
  useEscalations: vi.fn(),
}))

import { useCareRecord, useDoseHistory, useEscalations } from '../api/hooks'

const at = (h: number, m: number) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

const RECORD: CareRecord = {
  patient: {
    id: 'p1', caregiver_id: 'c1', name: 'Kamala', honorific: 'ji',
    phone_e164: '+919000000042', language: 'hi-IN', age: 71,
    conditions: [], allergies: [], doctor_name: null, doctor_phone: null,
    address_text: null, meal_times: null, schedule_signed_off_at: at(0, 0),
    calls_paused: false, intro_call_at: null, intro_call_status: 'done',
    consents: null, created_at: at(0, 0),
  },
  caregiver: {
    id: 'c1', name: 'Son', phone_e164: '+919812345678', email: null,
    relationship: 'son', created_at: at(0, 0),
  },
  medications: [
    { id: 'm1', patient_id: 'p1', name: 'Metformin', dose: '500mg', slots: ['08:30'],
      with_food: 'after', is_priority: false, stock_count: null },
  ],
}

const UNKNOWN_DOSE: DoseEvent = {
  id: 'd-unknown', patient_id: 'p1', medication_id: 'm1', slot_time: at(8, 30),
  call_session_id: null, status: 'unknown',
  note: 'Three attempts, the line did not connect.', created_at: at(9, 0),
}

const LINKED_ALERT: Escalation = {
  id: 'e1', patient_id: 'p1', intake_record_id: null, dose_event_id: 'd-unknown',
  level: 'P2', reason: 'three consecutive call attempts failed to connect',
  channel: 'whatsapp', sent_to: 'Son', sent_at: at(9, 6), delivery_status: 'delivered',
}

function mount(doses: DoseEvent[], escalations: Escalation[] = [], slots?: string[]) {
  // Built fresh per call. Mutating a shared fixture leaks into every later test.
  const record: CareRecord = {
    ...RECORD,
    medications: RECORD.medications.map((m) => ({ ...m, slots: slots ?? m.slots })),
  }
  vi.mocked(useCareRecord).mockReturnValue({
    data: record, isLoading: false, error: null, refetch: vi.fn(),
  } as unknown as ReturnType<typeof useCareRecord>)
  vi.mocked(useDoseHistory).mockReturnValue({
    data: doses, isLoading: false, error: null, refetch: vi.fn(),
  } as unknown as ReturnType<typeof useDoseHistory>)
  vi.mocked(useEscalations).mockReturnValue({
    data: escalations, isLoading: false, error: null, refetch: vi.fn(),
  } as unknown as ReturnType<typeof useEscalations>)

  return render(
    <MemoryRouter>
      <Calendar />
    </MemoryRouter>,
  )
}

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

describe('the four views', () => {
  const openView = async (label: string) => {
    await userEvent.click(screen.getByRole('button', { name: label }))
  }

  it('starts on the week', () => {
    mount([])
    expect(screen.getByText('The week · every dose at every time')).toBeInTheDocument()
  })

  it('day drops the week grid and keeps the timeline', async () => {
    mount([])
    await openView('Day')
    expect(screen.queryByText('The week · every dose at every time')).not.toBeInTheDocument()
    // The day timeline stays — it is the whole of the day view. ("Today" also names
    // the jump-to-today chip, so match the heading rather than the text alone.)
    expect(screen.getByText(/what was said on the call/i)).toBeInTheDocument()
  })

  it('month shows every day of the month as its own cell', async () => {
    mount([])
    await openView('Month')
    expect(screen.getByText(/each day shows confirmed out of due/i)).toBeInTheDocument()
    // A month grid is whole Monday-start weeks, so never fewer than 28 cells.
    const now = new Date()
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    expect(screen.getAllByRole('button', { name: /\w{3} \w{3} \d+ \d{4}/ }).length)
      .toBeGreaterThanOrEqual(last)
  })

  it('agenda reads the week straight through and drops the day timeline', async () => {
    mount([])
    await openView('Agenda')
    expect(screen.getByText('The week, in order')).toBeInTheDocument()
    expect(screen.queryByText(/what was said on the call/i)).not.toBeInTheDocument()
  })

  it('stepping moves by whatever the current view shows', async () => {
    mount([])
    // Week view steps a week; the label says so rather than always reading "week".
    expect(screen.getByRole('button', { name: '‹ Week' })).toBeInTheDocument()
    await openView('Day')
    expect(screen.getByRole('button', { name: '‹ Day' })).toBeInTheDocument()
    await openView('Month')
    expect(screen.getByRole('button', { name: '‹ Month' })).toBeInTheDocument()
  })

  it('printing switches to the agenda first rather than printing whatever is up', async () => {
    const print = vi.fn()
    vi.stubGlobal('print', print)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    mount([])
    await userEvent.click(screen.getByRole('button', { name: /print \/ share pdf/i }))
    expect(screen.getByText('The week, in order')).toBeInTheDocument()
    expect(print).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('the now chip', () => {
  it('marks a slot that is actually happening now', () => {
    mount([], [], [hhmm(new Date(Date.now() + 10 * 60_000))])
    expect(screen.getAllByText('now').length).toBeGreaterThan(0)
  })

  it('does not call a dose hours away "now"', () => {
    // Without an upper bound the chip landed on the next unanswered slot whenever
    // it was, so a dose six hours out was labelled as happening right now.
    mount([], [], [hhmm(new Date(Date.now() + 6 * 60 * 60_000))])
    expect(screen.queryByText('now')).not.toBeInTheDocument()
  })
})

describe('a dose that was taken', () => {
  it('shows when it was confirmed, not only that it was', () => {
    // Frame 1g. The time is when it was logged, which is deliberately not the slot:
    // a dose due at 08:30 and confirmed at 09:10 was still late.
    mount([
      { ...UNKNOWN_DOSE, id: 'd-ok', status: 'confirmed', note: null, created_at: at(9, 10) },
    ])

    expect(screen.getAllByText('taken').length).toBeGreaterThan(1)
    expect(screen.getAllByText(/9:10/).length).toBeGreaterThan(0)
  })

  it('does not invent a confirmation time for a dose nobody confirmed', () => {
    mount([UNKNOWN_DOSE])
    expect(screen.queryByText(/9:10/)).not.toBeInTheDocument()
  })
})

describe('a dose that could not be established', () => {
  it('renders as not known, and never as missed', () => {
    // The whole point of the status. `missed` asserts the dose was not taken;
    // nothing here established that either way.
    //
    // The legend prints all five words unconditionally, so it accounts for exactly
    // one occurrence of each. A second 'missed' would be the dose itself.
    mount([UNKNOWN_DOSE])

    expect(screen.getAllByText('missed')).toHaveLength(1)
    expect(screen.getAllByText('not known').length).toBeGreaterThan(1)
    expect(screen.getByText(/whether it was taken is not known/i)).toBeInTheDocument()
    expect(screen.getByText(/it is not recorded as missed/i)).toBeInTheDocument()
  })

  it('names the alert that fired about that dose', () => {
    mount([UNKNOWN_DOSE], [LINKED_ALERT])

    expect(
      screen.getByText(/three consecutive call attempts failed to connect/i),
    ).toBeInTheDocument()
    expect(screen.getByText('P2')).toBeInTheDocument()
  })

  it('offers a number the caregiver can actually dial', () => {
    mount([UNKNOWN_DOSE], [LINKED_ALERT])

    const call = screen.getByRole('link', { name: /call kamala yourself/i })
    expect(call).toHaveAttribute('href', 'tel:+919000000042')
  })

  it('does not pretend the other two routes are dialable', () => {
    // No second number and no neighbour are stored (SCHEMA-GAPS §5). A control
    // that looks dialable and silently does nothing is worse than one saying why.
    mount([UNKNOWN_DOSE], [LINKED_ALERT])

    expect(screen.queryByRole('link', { name: /try another number/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /ask a neighbour/i })).toBeNull()
    expect(screen.getByText(/need a second contact number/i)).toBeInTheDocument()
  })

  it('still shows missed as its own separate thing', () => {
    // More than the single legend entry, because the dose itself now says it too
    // (in both the day timeline and the week grid).
    mount([{ ...UNKNOWN_DOSE, id: 'd-missed', status: 'missed', note: null }])
    expect(screen.getAllByText('missed').length).toBeGreaterThan(1)
    expect(screen.queryByText(/it is not recorded as missed/i)).not.toBeInTheDocument()
  })
})
