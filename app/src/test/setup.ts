import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { clearFiles } from '../setup/files'

/**
 * Every test starts with an empty draft. The onboarding draft lives in
 * localStorage and is read at module scope, so a leftover from a previous test
 * would silently change what the screen under test believes has already happened.
 */
beforeEach(() => {
  localStorage.clear()
  // The staged-image map is module scope and would otherwise let one test's
  // prescription be visible to the next.
  clearFiles()
})

/**
 * jsdom implements neither of these. Prescription images are held as object URLs,
 * so without a stub every test that stages a file throws before it renders.
 */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
