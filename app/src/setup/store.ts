import { useCallback, useEffect, useState } from 'react'
import type { Severity, WithFood } from '../api/types'

/**
 * Onboarding draft state, persisted to localStorage so a reload mid-signup does not
 * cost the caregiver three minutes of typing (J1 targets the whole flow at ≤3 min).
 *
 * Nothing here is authoritative — it is a draft until the consent screen (1E.2) posts it.
 */

export interface DraftMedicine {
  id: string
  name: string
  dose: string
  slots: string[]
  with_food: WithFood
  is_priority: boolean
  /** A person must correct this row before it can be scheduled (wireframe 1e). */
  unclear?: boolean

  /* --- provenance, when the row came from a prescription photo -------------
   * Safety rule S3: every extracted medicine carries the verbatim text the model
   * claims it read, so the caregiver can check it against the paper rather than
   * confirming a value they have no way to verify. Optional because a row the
   * caregiver typed by hand has no reading to show. */

  /** Verbatim line the model read. Absent on hand-entered rows. */
  raw_line?: string
  /** Per-medicine, 0–1, as reported by the model. */
  confidence?: number
  /** Validation flags from design doc §7 — e.g. 'low_confidence'. */
  flags?: string[]
  /** Days written on the prescription. Nothing consumes this yet — `medications`
   *  has no end-date column (docs/SCHEMA-GAPS-LANE-C.md §4) — but dropping it at
   *  the boundary would lose a value that was legibly on the page. */
  duration_days?: number | null
  /** Read from the page, deliberately never scheduled: PRN, or a non-oral form. */
  excluded?: boolean
  exclusion_reason?: string | null
}

/** What the extractor reported about the document as a whole. */
export interface ExtractionMeta {
  doc_id: string
  model: string
  /**
   * The `DraftFile` ids this reading was produced from.
   *
   * This is what distinguishes "the caregiver came back to the same prescription"
   * from "the caregiver gave us a different one". Without it, `ocrDone` alone
   * suppresses the re-read and the previous prescription's medicines are shown
   * under the new photograph — which is the worst possible way to be wrong here,
   * because the schedule looks confirmed and belongs to someone else's page.
   */
  source_files: string[]
  needs_review: boolean
  review_reasons: string[]
  /** Lines the model returned that failed validation — shown, never dropped. */
  unparsed_lines: string[]
}

export interface DraftFile {
  id: string
  name: string
  size: number
  progress: number
  /** MIME type of the file the caregiver actually picked — drives the PDF vs image tile. */
  type?: string
}

export interface SetupDraft {
  /* 1a — auth */
  phone: string
  phoneVerified: boolean
  phoneOtpSent: boolean
  email: string
  emailVerified: boolean
  emailOtpSent: boolean

  /* 1b — parent */
  parentName: string
  honorific: string
  age: string
  relation: string
  parentPhone: string
  language: string
  conditions: string[]
  allergies: string[]
  doctorName: string
  doctorPhone: string
  address: string
  notes: string
  mealTimes: { breakfast: string; lunch: string; dinner: string }
  /** Master switch for agent check-in calls (wireframe 1b). */
  callsEnabled: boolean
  callWindowFrom: string
  callWindowTo: string
  escalation: { name: string; relationship: string; after: string }[]

  /* 1c/1d — prescription */
  files: DraftFile[]
  ocrDone: boolean
  /** Null until a prescription has actually been read. */
  extraction: ExtractionMeta | null

  /* 1e — schedule */
  medicines: DraftMedicine[]
  scheduleConfirmed: boolean

  /* 1E.2 — consent (filled in P3) */
  introCall: 'now' | 'later' | null
  introCallAt: string | null
  consents: Record<string, boolean>
}

export const EMPTY_DRAFT: SetupDraft = {
  phone: '',
  phoneVerified: false,
  phoneOtpSent: false,
  email: '',
  emailVerified: false,
  emailOtpSent: false,

  parentName: '',
  honorific: '',
  age: '',
  relation: '',
  parentPhone: '',
  language: '',
  conditions: [],
  allergies: [],
  doctorName: '',
  doctorPhone: '',
  address: '',
  notes: '',
  mealTimes: { breakfast: '08:00', lunch: '13:30', dinner: '20:30' },
  callsEnabled: true,
  callWindowFrom: '09:00',
  callWindowTo: '20:00',
  escalation: [],

  files: [],
  ocrDone: false,
  extraction: null,

  medicines: [],
  scheduleConfirmed: false,

  introCall: null,
  introCallAt: null,
  consents: {},
}

const KEY = 'kinvox.setup.draft.v1'

function read(): SetupDraft {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<SetupDraft>) } : EMPTY_DRAFT
  } catch {
    return EMPTY_DRAFT
  }
}

/** Cross-component sync without a state library: one storage event, one custom event. */
const CHANGED = 'kinvox:draft'

export function useSetupDraft() {
  const [draft, setDraft] = useState<SetupDraft>(read)

  useEffect(() => {
    const sync = () => setDraft(read())
    window.addEventListener(CHANGED, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGED, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const patch = useCallback((next: Partial<SetupDraft>) => {
    const merged = { ...read(), ...next }
    try {
      localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      /* private mode — the draft simply does not survive a reload */
    }
    window.dispatchEvent(new Event(CHANGED))
    setDraft(merged)
  }, [])

  const reset = useCallback(() => {
    localStorage.removeItem(KEY)
    window.dispatchEvent(new Event(CHANGED))
    setDraft(EMPTY_DRAFT)
  }, [])

  return { draft, patch, reset }
}

/* ------------------------------------------------------------- validation */

/** E.164 (FR-1 acceptance: the record stores E.164). */
export function toE164(input: string, cc = '+91'): string | null {
  const digits = input.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null
  const local = digits.replace(/^0+/, '')
  if (local.length !== 10) return null
  return `${cc}${local}`
}

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
export const isOtp = (v: string) => /^\d{6}$/.test(v)

/** Wireframe 1b shows a live "n left" counter beside the disabled CTA. */
export const PARENT_REQUIRED = [
  'parentName',
  'age',
  'relation',
  'parentPhone',
  'language',
] as const satisfies readonly (keyof SetupDraft)[]

export function missingParentFields(d: SetupDraft): string[] {
  return PARENT_REQUIRED.filter((k) => {
    const v = d[k]
    if (k === 'parentPhone') return !toE164(String(v))
    return String(v ?? '').trim() === ''
  })
}

/** Severity is unused here but re-exported so screens import one module. */
export type { Severity }
