import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSetupDraft } from './store'

const KEY = 'kinvox.setup.draft.v1'

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '{}')

describe('the signup fields', () => {
  // The auth fields are module state now, not localStorage, so the global
  // `localStorage.clear()` in test/setup.ts no longer isolates them. Reset
  // explicitly — without this a phone number typed in one test prefills the next,
  // which is the very bug under test.
  beforeEach(() => {
    const { result } = renderHook(() => useSetupDraft())
    act(() => result.current.reset())
    localStorage.clear()
  })

  it('are never written to localStorage', () => {
    const { result } = renderHook(() => useSetupDraft())

    act(() => result.current.patch({ phone: '+919000000001', email: 'a@b.com', parentName: 'Sunita' }))

    expect(stored().phone).toBeUndefined()
    expect(stored().email).toBeUndefined()
    // The rest of the draft still persists — only auth was carved out.
    expect(stored().parentName).toBe('Sunita')
  })

  it('still hold for the length of the session, across unrelated patches', () => {
    const { result } = renderHook(() => useSetupDraft())

    act(() => result.current.patch({ phone: '+919000000001', phoneOtpSent: true }))
    act(() => result.current.patch({ parentName: 'Sunita' }))

    // Losing phoneOtpSent here would drop the caregiver back to step 1 mid-flow.
    expect(result.current.draft.phone).toBe('+919000000001')
    expect(result.current.draft.phoneOtpSent).toBe(true)
  })

  it('do not come back from a draft an older build persisted', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ phone: '+919876543210', phoneVerified: true, parentName: 'Sunita' }),
    )

    const { result } = renderHook(() => useSetupDraft())

    // The exact bug: the dev seed's number prefilling a real caregiver's signup.
    expect(result.current.draft.phone).toBe('')
    expect(result.current.draft.phoneVerified).toBe(false)
    expect(result.current.draft.parentName).toBe('Sunita')
  })

  it('are purged from storage on the next write', () => {
    localStorage.setItem(KEY, JSON.stringify({ phone: '+919876543210', parentName: 'Sunita' }))

    const { result } = renderHook(() => useSetupDraft())
    act(() => result.current.patch({ age: '71' }))

    expect(stored().phone).toBeUndefined()
    expect(stored().age).toBe('71')
  })

  it('are cleared by reset', () => {
    const { result } = renderHook(() => useSetupDraft())

    act(() => result.current.patch({ phone: '+919000000001' }))
    act(() => result.current.reset())

    expect(result.current.draft.phone).toBe('')
  })
})
