import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { clearFiles } from '../setup/files'

/**
 * Node 25 exposes its own experimental `localStorage` global, and it wins over the
 * one jsdom installs. Without a `--localstorage-file` backing it that global is a
 * stub — `clear` is not even a function — so every test touching the draft died in
 * the hook below before it rendered anything. Swap in a real in-memory Storage
 * when the ambient one cannot do the job.
 */
if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map<string, string>()
  const memory: Storage = {
    get length() {
      return store.size
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true })
}

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

/**
 * jsdom has no layout, so it has no scrollIntoView either. Any screen that
 * keeps a growing list pinned to its last item (the /setup/meet transcript)
 * throws in its mount effect without this.
 */
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}
if (typeof Element.prototype.scrollTo !== 'function') {
  // AppShell scrolls <main> back to the top on every route change.
  Element.prototype.scrollTo = () => {}
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
