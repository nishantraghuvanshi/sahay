import { EXTRACT_API_BASE } from '../config'
import type { WithFood } from './types'

/**
 * Prescription extraction — the caregiver app's side of POST /extract.
 *
 * The server returns a *reviewable* schedule, never a confirmed one. Nothing here
 * may reach the reminder scheduler without the explicit sign-off on the review
 * screen; `needs_review: false` reduces how much the caregiver has to check, it
 * does not remove the check.
 */

/** Mirrors NormalizedMedicine in api/rx_extract/normalize.py. */
export interface ExtractedMedicine {
  id: string
  name: string
  dose: string
  /** Local 'HH:MM'. Empty for anything excluded from calls. */
  slots: string[]
  with_food: WithFood
  is_priority: boolean
  /** A human must correct this row before it can be scheduled. */
  unclear: boolean
  /** Verbatim text the model claims it read — shown beside the photo (S3/S6). */
  raw_line: string
  confidence: number
  flags: string[]
  duration_days: number | null
  /** Extracted and shown, but never scheduled (PRN, injection, ointment, drops). */
  excluded: boolean
  exclusion_reason: string | null
}

export interface ExtractedSchedule {
  doc_id: string
  model: string
  medicines: ExtractedMedicine[]
  /** Lines the model returned that failed validation — surfaced, not dropped. */
  unparsed_lines: string[]
  needs_review: boolean
  review_reasons: string[]
}

/**
 * `blocked` is the one that must never be collapsed into any other case. It means
 * the model *refused to read the image* — not that the page had no medicines on
 * it. Rendering it as an empty schedule would show a caregiver a prescription
 * with nothing on it and invite them to sign off on that.
 */
export type ExtractErrorKind =
  'blocked' | 'transient' | 'config' | 'unsupported_media' | 'too_large' | 'empty_file' | 'network'

export interface ExtractError {
  kind: ExtractErrorKind
  message: string
  retryable: boolean
  needs_human_review: boolean
}

/**
 * A result type rather than a thrown error, deliberately. Each failure kind has to
 * be rendered differently, and an exception invites the `catch { return null }`
 * that would erase the blocked/empty distinction this whole pipeline exists to
 * preserve. Making the caller destructure `ok` means they cannot skip it.
 */
export type ExtractResult =
  { ok: true; schedule: ExtractedSchedule } | { ok: false; error: ExtractError }

/** No extraction service configured (config.ts) — fall back to the fixture. */
const isMock = !EXTRACT_API_BASE

const MOCK_DOC = 'rx_mock_0001'

/**
 * The same three medicines as scripts/mock-api.json, so the app standalone still
 * demonstrates the flow — including one unclear row, which is what makes the
 * review gate visible. Atorvastatin's strength is deliberately unread.
 */
const MOCK: ExtractedSchedule = {
  doc_id: MOCK_DOC,
  model: 'mock:no-vlm-configured',
  medicines: [
    {
      id: `${MOCK_DOC}-1`,
      name: 'Metformin',
      dose: '500mg',
      slots: ['08:30', '21:00'],
      with_food: 'after',
      is_priority: false,
      unclear: false,
      raw_line: '1) T. Metformin 500  1-0-1  x 30 days  (a/f)',
      confidence: 0.94,
      flags: [],
      duration_days: 30,
      excluded: false,
      exclusion_reason: null,
    },
    {
      id: `${MOCK_DOC}-2`,
      name: 'Amlodipine',
      dose: '5mg',
      slots: ['08:00'],
      with_food: 'any',
      is_priority: false,
      unclear: false,
      raw_line: '2) T. Amlodipine 5  1-0-0  x 30 days',
      confidence: 0.91,
      flags: [],
      duration_days: 30,
      excluded: false,
      exclusion_reason: null,
    },
    {
      id: `${MOCK_DOC}-3`,
      name: 'Atorvastatin',
      dose: '',
      slots: ['21:00'],
      with_food: 'after',
      is_priority: false,
      unclear: true,
      raw_line: '3) T. Atorvas ??  0-0-1  (a/f)',
      confidence: 0.41,
      flags: ['low_confidence'],
      duration_days: null,
      excluded: false,
      exclusion_reason: null,
    },
  ],
  unparsed_lines: [],
  needs_review: true,
  review_reasons: ['unclear_rows'],
}

const fail = (
  kind: ExtractErrorKind,
  message: string,
  retryable = false,
  review = false,
): ExtractResult => ({
  ok: false,
  error: { kind, message, retryable, needs_human_review: review },
})

/**
 * Extract one prescription image.
 *
 * `mealTimes` anchors the abstract morning/afternoon/night slots the model returns
 * onto the patient's actual routine, so a reminder lands when they really eat
 * rather than at a hardcoded 08:00.
 */
export async function extractPrescription(
  file: File,
  mealTimes?: { breakfast: string; lunch: string; dinner: string },
  signal?: AbortSignal,
): Promise<ExtractResult> {
  if (isMock) {
    await new Promise((r) => setTimeout(r, 900))
    return { ok: true, schedule: MOCK }
  }

  const body = new FormData()
  body.append('file', file)
  if (mealTimes) body.append('meal_times', JSON.stringify(mealTimes))

  let response: Response
  try {
    response = await fetch(`${EXTRACT_API_BASE}/extract`, {
      method: 'POST',
      body,
      signal,
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    return fail('network', 'Could not reach the server. Check your connection and try again.', true)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return fail('transient', 'The server sent a response we could not read.', true)
  }

  const data = payload as {
    ok?: boolean
    schedule?: ExtractedSchedule
    error?: ExtractError
  }
  if (data?.ok === true && data.schedule) return { ok: true, schedule: data.schedule }

  if (data?.error?.kind) return { ok: false, error: data.error }

  // No recognisable envelope. Treat as transient rather than inventing an empty
  // schedule — an unreadable failure is still a failure, not an empty page.
  return fail('transient', `Extraction failed (HTTP ${response.status}).`, true)
}
