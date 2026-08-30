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
  /** OCR could not read this row confidently — highlighted for review (wireframe 1e). */
  unclear?: boolean
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
