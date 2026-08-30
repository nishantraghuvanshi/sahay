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
  /** When the code was sent, epoch ms. The flag survives a reload on purpose, but
   *  the code behind it dies in `otp_ttl_min` (api/config.py), so a flag with no
   *  timestamp — or an old one — means "no code is in flight", not "resume". */
  phoneOtpSentAt: number | null
  email: string
  emailVerified: boolean
  emailOtpSent: boolean
  emailOtpSentAt: number | null

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
  phoneOtpSentAt: null,
  email: '',
  emailVerified: false,
  emailOtpSent: false,
  emailOtpSentAt: null,

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

/**
 * The signup fields, deliberately excluded from localStorage.
 *
 * Persisting these made every later visit open on a phone number the caregiver
 * did not type in this session — their own from a previous attempt, or the
 * VITE_DEV_MODE seed, which is written once per browser and outlives the flag
 * that wrote it (devSeed.ts). A prefilled identity field is the one kind of
 * stale draft that is actively wrong: the rest of the draft is the caregiver's
 * own typing to be resumed, this is a claim about who they are.
 *
 * They still behave normally for the length of the tab — the OTP steps depend on
 * `phoneOtpSent` surviving between patches — so they live in memory instead.
 * A reload starts signup clean, which is correct: the code behind a sent OTP is
 * server-side and short-lived, and `session.phone_verified` is the real record
 * of who is verified.
 */
const AUTH_KEYS = [
  'phone',
  'phoneVerified',
  'phoneOtpSent',
  'phoneOtpSentAt',
  'email',
  'emailVerified',
  'emailOtpSent',
  'emailOtpSentAt',
] as const

type AuthKey = (typeof AUTH_KEYS)[number]

/** Tab-lifetime only. Reset by `reset()`, gone on reload. */
let authState: Pick<SetupDraft, AuthKey> = pickAuth(EMPTY_DRAFT)

function pickAuth(from: SetupDraft): Pick<SetupDraft, AuthKey> {
  return Object.fromEntries(AUTH_KEYS.map((k) => [k, from[k]])) as Pick<SetupDraft, AuthKey>
}

/** Strip the auth fields from anything headed for — or coming out of — storage. */
function withoutAuth(d: Partial<SetupDraft>): Partial<SetupDraft> {
  const out = { ...d }
  for (const k of AUTH_KEYS) delete out[k]
  return out
}

function read(): SetupDraft {
  let stored: Partial<SetupDraft> = {}
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) stored = JSON.parse(raw) as Partial<SetupDraft>
  } catch {
    /* unreadable or unparseable — treat as no draft */
  }
  // Auth last: a blob written by an older build still carries these keys, and
  // stripping them on the way out is what un-prefills an existing browser.
  return { ...EMPTY_DRAFT, ...withoutAuth(stored), ...authState }
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
    authState = pickAuth(merged)
    try {
      localStorage.setItem(KEY, JSON.stringify(withoutAuth(merged)))
    } catch {
      /* private mode — the draft simply does not survive a reload */
    }
    window.dispatchEvent(new Event(CHANGED))
    setDraft(merged)
  }, [])

  const reset = useCallback(() => {
    localStorage.removeItem(KEY)
    authState = pickAuth(EMPTY_DRAFT)
    window.dispatchEvent(new Event(CHANGED))
    setDraft(EMPTY_DRAFT)
  }, [])

  return { draft, patch, reset }
}

/* ------------------------------------------------------------- validation */

/**
 * E.164 (FR-1 acceptance: the record stores E.164). India only: the user types the
 * 10-digit mobile number and we prefix +91 ourselves. A pasted "+91 …", "91 …" or
 * "0 …" is tolerated so a number copied from contacts still works.
 */
export function toE164(input: string): string | null {
  let digits = input.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  // Indian mobiles are 10 digits and start with 6–9.
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null
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
