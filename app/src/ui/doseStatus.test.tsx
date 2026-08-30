import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DoseStatusChip } from './index'

/**
 * Ported from Calendar.test.tsx, which the origin/main merge parked.
 *
 * Thirteen of those assertions pinned features the merge removed — view modes,
 * print, the dialable number, the "happening now" marker. These two did not:
 * they are about what a dose STATE means to a caregiver, and that rule survived
 * the merge intact because the six dose states were kept.
 *
 * They belong here rather than on a screen. The rule lives in DoseStatusChip,
 * so a screen test could only ever reach it at second hand — and did, which is
 * why replacing the screen took the coverage with it.
 */
describe('what a dose state says to a caregiver', () => {
  it('renders a no-answer as not known, and never as missed', () => {
    // The distinction the whole outcome vocabulary exists to preserve: nobody
    // picked up is not the same fact as the dose was not taken, and a caregiver
    // acting on the wrong one either panics or is falsely reassured.
    render(<DoseStatusChip status="no_answer" />)
    expect(screen.getByText(/no answer/i)).toBeInTheDocument()
    expect(screen.queryByText(/^missed$/i)).not.toBeInTheDocument()
  })

  it('keeps missed as its own distinct thing', () => {
    render(<DoseStatusChip status="missed" />)
    expect(screen.getByText(/^missed$/i)).toBeInTheDocument()
  })

  it('renders unknown as not known rather than borrowing another state', () => {
    // `unknown` is ours — the agent answered but the caller's meaning could not
    // be established. origin/main's DOSE_LABEL covered four states and would not
    // have rendered this at all.
    render(<DoseStatusChip status="unknown" />)
    expect(screen.getByText(/not known/i)).toBeInTheDocument()
  })

  it('never renders a state as blank, whatever it is', () => {
    // DOSE_LABEL is a Record over the whole union. A missing member does not
    // merely lose a word, it fails to typecheck — but a blank label would be
    // the worst outcome, so it is asserted rather than assumed.
    for (const status of ['pending', 'confirmed', 'deferred', 'missed', 'no_answer', 'unknown'] as const) {
      const { unmount } = render(<DoseStatusChip status={status} />)
      expect(document.body.textContent?.trim()).not.toBe('')
      unmount()
    }
  })
})
