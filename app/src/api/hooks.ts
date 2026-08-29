import { useQuery } from '@tanstack/react-query'
import { API_BASE, LIVE_POLL_MS } from '../config'
import { ApiError, api } from './client'
import { mock } from './mock'
import type {
  CallSession,
  CareRecord,
  DaySummary,
  DoseEvent,
  Escalation,
  HandoffView,
  IntakeRecord,
  Observation,
} from './types'

/**
 * Screens call these and nothing else. Swapping mock → live is the API_BASE constant
 * plus these five `source` lines; no screen changes.
 */
const live = API_BASE !== '/mock'

const source = {
  careRecord: () => (live ? api.get<CareRecord>('/app/record') : mock.careRecord()),
  doses: () => (live ? api.get<DoseEvent[]>('/app/doses') : mock.doseEvents()),
  observations: () => (live ? api.get<Observation[]>('/app/observations') : mock.observations()),
  escalations: () => (live ? api.get<Escalation[]>('/app/escalations') : mock.escalations()),
  calls: () => (live ? api.get<CallSession[]>('/app/calls') : mock.callSessions()),
  summary: () => (live ? api.get<DaySummary>('/app/summary') : mock.daySummary()),
  intake: (id: string) => (live ? api.get<IntakeRecord>(`/app/intake/${id}`) : mock.intake(id)),
  handoff: (token: string) => (live ? api.get<HandoffView>(`/h/${token}`) : mock.handoff(token)),
}

/**
 * Post a completed onboarding. Live only — there is nothing to write to in mock
 * mode, and pretending to save would be worse than saying so.
 */
export async function postOnboarding(draft: unknown): Promise<{ patient_id: string }> {
  if (!live) throw new ApiError('No Care API configured — nothing was saved.', 'unreachable')
  return api.post<{ patient_id: string }>('/app/onboarding', draft)
}

/**
 * Persist an edited schedule together with the attestation that justified it.
 * `diff` is the human-readable change list the editor already computes for the
 * "What changes for Mom" card, stored verbatim as the audit trail.
 */
export async function postMedications(body: {
  medications: unknown[]
  diff: string[]
  consent_text: string
  consent_ack: boolean
}): Promise<{ changed: number }> {
  if (!live) throw new ApiError('No Care API configured — nothing was saved.', 'unreachable')
  return api.post<{ changed: number }>('/app/medications', body)
}

/**
 * Record a dose the caregiver confirmed themselves. Writing the event is what stops
 * the agent calling about that slot — the scheduler only dials slots with no
 * dose_events row — so there is no separate flag that could fall out of step.
 */
export async function postDose(body: {
  medication_id: string
  slot_time: string
  status?: string
  note?: string | null
}): Promise<void> {
  if (!live) throw new ApiError('No Care API configured — nothing was saved.', 'unreachable')
  await api.post('/app/doses', body)
}

/** Screens that must visibly change while a call is in progress poll; the rest do not. */
const LIVE = { refetchInterval: LIVE_POLL_MS }

export const useCareRecord = () =>
  useQuery({ queryKey: ['record'], queryFn: source.careRecord, ...LIVE })

export const useDoseHistory = () =>
  useQuery({ queryKey: ['doses'], queryFn: source.doses, ...LIVE })

export const useDaySummary = () =>
  useQuery({ queryKey: ['summary'], queryFn: source.summary, ...LIVE })

export const useObservations = () =>
  useQuery({ queryKey: ['observations'], queryFn: source.observations, ...LIVE })

export const useEscalations = () =>
  useQuery({ queryKey: ['escalations'], queryFn: source.escalations, ...LIVE })

export const useCalls = () => useQuery({ queryKey: ['calls'], queryFn: source.calls })

export const useIntake = (id: string | undefined) =>
  useQuery({
    queryKey: ['intake', id],
    queryFn: () => source.intake(id!),
    enabled: Boolean(id),
  })

export const useHandoff = (token: string | undefined) =>
  useQuery({
    queryKey: ['handoff', token],
    queryFn: () => source.handoff(token!),
    enabled: Boolean(token),
    retry: false,
  })
