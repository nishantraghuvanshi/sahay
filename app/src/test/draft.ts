import { EMPTY_DRAFT } from '../setup/store'
import type { SetupDraft } from '../setup/store'
import type { ExtractedMedicine, ExtractedSchedule } from '../api/extract'

/** Write a draft straight into localStorage, as the earlier setup steps would have. */
export function seedDraft(patch: Partial<SetupDraft>): void {
  localStorage.setItem('voxikin.setup.draft.v1', JSON.stringify({ ...EMPTY_DRAFT, ...patch }))
}

/** Read the draft back, as the next setup step would. */
export function readDraft(): SetupDraft {
  const raw = localStorage.getItem('voxikin.setup.draft.v1')
  return { ...EMPTY_DRAFT, ...(raw ? (JSON.parse(raw) as Partial<SetupDraft>) : {}) }
}

export function stageFile(name = 'rx.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
}

export function medicine(over: Partial<ExtractedMedicine> = {}): ExtractedMedicine {
  return {
    id: 'x-1',
    name: 'Dolo 650',
    dose: '650mg',
    slots: ['08:30', '21:00'],
    with_food: 'after',
    is_priority: false,
    unclear: false,
    raw_line: '1) T. Dolo 650 1-0-1 x 5 days (a/f)',
    confidence: 0.94,
    flags: [],
    duration_days: 5,
    excluded: false,
    exclusion_reason: null,
    ...over,
  }
}

export function schedule(medicines: ExtractedMedicine[], over: Partial<ExtractedSchedule> = {}): ExtractedSchedule {
  return {
    doc_id: 'rx_test_0001',
    model: 'test:fake',
    medicines,
    unparsed_lines: [],
    needs_review: medicines.some((m) => m.unclear),
    review_reasons: [],
    ...over,
  }
}
