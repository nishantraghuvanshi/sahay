/**
 * Mirrors the tables in TRD §3, column names unchanged, so a judge reading this file
 * sees the schema. Do not rename fields to be "nicer" — the record must match the DB.
 */

export type DoseStatus = 'confirmed' | 'deferred' | 'missed' | 'no_answer'
export type Severity = 'none' | 'watch' | 'red'
export type Priority = 'P1' | 'P2' | 'P3'
export type ObservationKind = 'symptom' | 'mood' | 'note'
export type CallDirection = 'in' | 'out'
export type WithFood = 'before' | 'after' | 'any'
export type EscalationChannel = 'whatsapp' | 'sms' | 'call'

export interface Caregiver {
  id: string
  name: string
  phone_e164: string
  email: string | null
  relationship: string | null
  created_at: string
}

export interface Patient {
  id: string
  caregiver_id: string
  name: string
  honorific: string | null
  phone_e164: string
  language: string
  age: number | null
  conditions: string[]
  allergies: string[]
  doctor_name: string | null
  doctor_phone: string | null
  address_text: string | null
  meal_times: Record<string, string> | null
  /** FR-4 gate. null = no call may ever be placed. */
  schedule_signed_off_at: string | null
  /** SR-5 — the parent asked us to stop. */
  calls_paused: boolean

  /**
   * The one-off consent call (FR-5). `intro_call_status` is load-bearing rather
   * than informational: no dose slot may be dialled until it is 'done', or the
   * product rings a parent who never agreed to be rung.
   */
  intro_call_at: string | null
  intro_call_status: 'pending' | 'done' | 'declined' | null
  /** Stored with their text, not as bare booleans — SR-5. */
  consents: { id: string; agreed: boolean; agreed_at: string | null }[] | null

  created_at: string
}

export interface Medication {
  id: string
  patient_id: string
  name: string
  dose: string
  /** Local times, e.g. ['08:30','21:00'] */
  slots: string[]
  with_food: WithFood | null
  /** At most one per patient. */
  is_priority: boolean
  stock_count: number | null
}

export interface CallSession {
  id: string
  patient_id: string | null
  direction: CallDirection
  status: string
  started_at: string
  ended_at: string | null
  transcript: string | null
  safety_pass: boolean | null
}

export interface DoseEvent {
  id: string
  patient_id: string
  medication_id: string
  slot_time: string
  call_session_id: string | null
  status: DoseStatus
  note: string | null
  created_at: string
}

export interface Observation {
  id: string
  patient_id: string
  call_session_id: string | null
  kind: ObservationKind
  /** VERBATIM. Never paraphrase, never truncate in the UI. */
  text: string
  severity: Severity
  created_at: string
}

/** The 12 fields of PRD §9.2. Six are inherited rather than asked. */
export interface IntakeFields {
  caller_identity?: string
  patient_identity?: string
  chief_complaint?: string
  onset_time?: string
  responsive?: string
  breathing?: string
  location?: string
  current_medications?: string
  known_allergies?: string
  known_conditions?: string
  callback_number?: string
}

export const INTAKE_FIELD_COUNT = 12

export interface IntakeRecord {
  id: string
  patient_id: string | null
  call_session_id: string
  fields: IntakeFields
  /** captured / 12 */
  completeness: number
  priority: Priority | null
  /** The literal rule text. Never empty, never just the level (PR-3). */
  priority_rule: string | null
  status: 'open' | 'handed_off'
  updated_at: string
}

export interface Escalation {
  id: string
  patient_id: string
  intake_record_id: string | null
  level: Priority
  /** The cited rule — rendered literally in the feed. */
  reason: string
  channel: EscalationChannel
  sent_to: string
  sent_at: string | null
  delivery_status: string | null
}

export interface Handoff {
  id: string
  intake_record_id: string
  token: string
  created_at: string
  expires_at: string | null
  viewed_at: string | null
}

/** Shape returned by the handoff route — everything the recipient needs, nothing else. */
export interface HandoffView {
  patient: Pick<Patient, 'name' | 'honorific' | 'age' | 'conditions' | 'allergies' | 'address_text'>
  medications: Pick<Medication, 'name' | 'dose' | 'slots' | 'with_food'>[]
  intake: IntakeRecord
  callback_number: string
  viewed_at: string | null
  expires_at: string | null
}

/** Home "Today so far" roll-up (wireframe 1f/2e). Derived, never stored. */
export interface DaySummaryItem {
  at: string
  kind: 'dose' | 'call' | 'observation' | 'escalation'
  text: string
  status?: DoseStatus
  severity?: Severity
  href?: string
}

export interface DaySummary {
  since: string
  items: DaySummaryItem[]
  doses_confirmed: number
  doses_total: number
  calls: number
  alerts: number
}

/** Everything the record screen needs in one payload. */
export interface CareRecord {
  patient: Patient
  caregiver: Caregiver
  medications: Medication[]
}
