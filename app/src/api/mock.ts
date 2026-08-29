import seed from '../../../scripts/mock-api.json'
import type {
  CallSession,
  CareRecord,
  DaySummary,
  DaySummaryItem,
  DoseEvent,
  Escalation,
  Handoff,
  HandoffView,
  IntakeRecord,
  Observation,
} from './types'
import { ApiError } from './client'

/**
 * Mock adapter. Same shapes Lane B will return, so integration is a base-URL swap
 * and no screen shifts (LANE-C-APP.md).
 *
 * `?fail=doses` etc. forces an error so the error states can be demonstrated
 * without breaking the backend. `?empty=1` renders the day-one experience.
 */

/** The fixture is anchored to this date; everything is rebased onto today. */
const ANCHOR = '2026-08-30'

const dayShift = (() => {
  const anchor = new Date(`${ANCHOR}T00:00:00+05:30`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((today.getTime() - anchor.getTime()) / 86_400_000)
})()

function rebase<T>(value: T): T {
  if (typeof value === 'string') {
    // ISO timestamp → shift by whole days so "yesterday" stays yesterday.
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const d = new Date(value)
      d.setDate(d.getDate() + dayShift)
      return d.toISOString() as unknown as T
    }
    return value
  }
  if (Array.isArray(value)) return value.map(rebase) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rebase(v)]),
    ) as T
  }
  return value
}

const db = rebase(seed as unknown as {
  caregiver: CareRecord['caregiver']
  patient: CareRecord['patient']
  medications: CareRecord['medications']
  call_sessions: CallSession[]
  dose_events: DoseEvent[]
  observations: Observation[]
  intake_records: IntakeRecord[]
  escalations: Escalation[]
  handoffs: Handoff[]
})

const params = () => new URLSearchParams(window.location.search)
const isEmpty = () => params().get('empty') === '1'
const latency = () => 180 + Math.random() * 220

async function respond<T>(key: string, value: T): Promise<T> {
  await new Promise((r) => setTimeout(r, latency()))
  const fail = params().get('fail')
  if (fail === key || fail === 'all') {
    throw new ApiError('Cannot reach the Care API.', 'unreachable')
  }
  return value
}

const byNewest = (a: { created_at: string }, b: { created_at: string }) =>
  b.created_at.localeCompare(a.created_at)

export const mock = {
  careRecord: () =>
    respond<CareRecord>('record', {
      patient: db.patient,
      caregiver: db.caregiver,
      medications: isEmpty() ? [] : db.medications,
    }),

  doseEvents: () => respond<DoseEvent[]>('doses', isEmpty() ? [] : db.dose_events),

  observations: () =>
    respond<Observation[]>('observations', isEmpty() ? [] : [...db.observations].sort(byNewest)),

  escalations: () => respond<Escalation[]>('escalations', isEmpty() ? [] : db.escalations),

  callSessions: () => respond<CallSession[]>('calls', isEmpty() ? [] : db.call_sessions),

  intake: (id: string) => {
    const found = db.intake_records.find((r) => r.id === id)
    if (!found) throw new ApiError('We could not find that record.', 'not_found')
    return respond<IntakeRecord>('intake', found)
  },

  /** Derived, never stored — every dose, call and alert since 06:00 today (wireframe 1f). */
  daySummary: () => {
    const since = new Date()
    since.setHours(6, 0, 0, 0)
    const medName = (id: string) => db.medications.find((m) => m.id === id)?.name ?? 'Medicine'

    const items: DaySummaryItem[] = isEmpty()
      ? []
      : [
          ...db.dose_events
            .filter((d) => new Date(d.slot_time) >= since && new Date(d.slot_time) <= new Date())
            .map<DaySummaryItem>((d) => ({
              at: d.slot_time,
              kind: 'dose',
              status: d.status,
              text:
                d.status === 'confirmed'
                  ? `${medName(d.medication_id)} confirmed`
                  : d.status === 'missed'
                    ? `${medName(d.medication_id)} missed${d.note ? ` — ${d.note}` : ''}`
                    : d.status === 'no_answer'
                      ? `${medName(d.medication_id)} — no answer`
                      : d.status === 'unknown'
                        ? `${medName(d.medication_id)} — could not reach them`
                        : `${medName(d.medication_id)} deferred`,
              href: '/doses',
            })),
          ...db.call_sessions
            .filter((c) => new Date(c.started_at) >= since)
            .map<DaySummaryItem>((c) => ({
              at: c.started_at,
              kind: 'call',
              text:
                c.status === 'no_answer'
                  ? 'Check-in call not answered'
                  : c.direction === 'in'
                    ? 'Sharma-ji called in'
                    : 'Check-in call answered',
              href: `/calls/${c.id}`,
            })),
          ...db.observations
            .filter((o) => new Date(o.created_at) >= since)
            .map<DaySummaryItem>((o) => ({
              at: o.created_at,
              kind: 'observation',
              severity: o.severity,
              text: o.text,
              href: '/observations',
            })),
          ...db.escalations
            .filter((e) => e.sent_at && new Date(e.sent_at) >= since)
            .map<DaySummaryItem>((e) => ({
              at: e.sent_at!,
              kind: 'escalation',
              text: `${e.level} — ${e.reason}`,
              href: `/alerts/${e.id}`,
            })),
        ].sort((a, b) => a.at.localeCompare(b.at))

    const todaysDoses = isEmpty()
      ? []
      : db.dose_events.filter((d) => new Date(d.slot_time).toDateString() === new Date().toDateString())

    return respond<DaySummary>('summary', {
      since: since.toISOString(),
      items,
      doses_confirmed: todaysDoses.filter((d) => d.status === 'confirmed').length,
      doses_total: todaysDoses.length,
      calls: items.filter((i) => i.kind === 'call').length,
      alerts: items.filter((i) => i.kind === 'escalation').length,
    })
  },

  handoff: (token: string) => {
    const handoff = db.handoffs.find((h) => h.token === token)
    if (!handoff) throw new ApiError('This link is not valid.', 'not_found')
    if (handoff.expires_at && new Date(handoff.expires_at) < new Date()) {
      throw new ApiError('This link has expired.', 'expired')
    }
    const intake = db.intake_records.find((r) => r.id === handoff.intake_record_id)!
    return respond<HandoffView>('handoff', {
      patient: {
        name: db.patient.name,
        honorific: db.patient.honorific,
        age: db.patient.age,
        conditions: db.patient.conditions,
        allergies: db.patient.allergies,
        address_text: db.patient.address_text,
      },
      medications: db.medications.map(({ name, dose, slots, with_food }) => ({
        name,
        dose,
        slots,
        with_food,
      })),
      intake,
      callback_number: db.patient.phone_e164,
      viewed_at: handoff.viewed_at,
      expires_at: handoff.expires_at,
    })
  },
}

export const USING_MOCK = true
