import { DEV_MODE } from '../config'
import { DRAFT_KEY, EMPTY_DRAFT, type SetupDraft } from './store'
import type { Caregiver } from '../auth/api'

/**
 * VITE_DEV_MODE=true: skip login and the parent form, land on prescription upload
 * with a realistic draft already filled in. Only honoured in a Vite dev build
 * (see DEV_MODE in config.ts), so this cannot leak into production.
 */

export const DEV_CAREGIVER: Caregiver = {
  id: 'dev-caregiver',
  name: 'Dev Caregiver',
  phone_e164: '+919876543210',
  email: 'dev@voxikin.local',
  relationship: 'Daughter',
  phone_verified: true,
  email_verified: true,
}

export const DEV_DRAFT: SetupDraft = {
  ...EMPTY_DRAFT,
  phone: '+919876543210',
  phoneVerified: true,
  phoneOtpSent: true,
  email: 'dev@voxikin.local',
  emailVerified: true,
  emailOtpSent: true,

  parentName: 'Sunita Sharma',
  honorific: 'Mummy',
  age: '71',
  relation: 'Mother',
  parentPhone: '+919812345678',
  language: 'hi-IN',
  conditions: ['Hypertension', 'Type-2 diabetes'],
  allergies: ['Penicillin'],
  doctorName: 'Dr Rao',
  doctorPhone: '+919898989898',
  address: '12 Lajpat Nagar, New Delhi 110024',
  notes: 'Forgets the evening dose when watching TV.',
  escalation: [{ name: 'Rahul Sharma', relationship: 'Son', after: '15 min' }],
}

const SEEDED = 'voxikin.setup.devSeeded'

/** Seed once per browser so edits made while testing are not clobbered on every reload. */
export function seedDevDraftOnce(patch: (next: Partial<SetupDraft>) => void) {
  if (!DEV_MODE) return
  try {
    if (localStorage.getItem(SEEDED)) return
    patch(DEV_DRAFT)
    localStorage.setItem(SEEDED, '1')
  } catch {
    /* private mode */
  }
}

/**
 * Undo a seed left behind by an earlier VITE_DEV_MODE session.
 *
 * `seedDevDraftOnce` is once-per-browser and its marker outlives the flag that
 * set it, so turning DEV_MODE off stopped new seeding but left Sunita Sharma,
 * her address and her phone number sitting in a real caregiver's onboarding —
 * indistinguishable from their own typing, because the seed writes into the same
 * draft. Whole-draft removal is right: if the marker is set, everything in that
 * draft came from the seed.
 */
export function purgeDevSeedIfDisabled(): void {
  if (DEV_MODE) return
  try {
    if (!localStorage.getItem(SEEDED)) return
    localStorage.removeItem(DRAFT_KEY)
    localStorage.removeItem(SEEDED)
  } catch {
    /* private mode — nothing was persisted to purge */
  }
}
