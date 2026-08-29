import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
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

function mount(doses: DoseEvent[], escalations: Escalation[] = []) {
  vi.mocked(useCareRecord).mockReturnValue({
    data: RECORD, isLoading: false, error: null, refetch: vi.fn(),
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
