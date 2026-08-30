import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import Prescription from './Prescription'
import { getFile } from '../../setup/files'
import { readDraft, stageFile } from '../../test/draft'

/**
 * The seam between this screen and the analysing screen.
 *
 * Analysing.test.tsx stages its own fixture with `putFile`, so it proves the reading
 * works *given* the bytes. Nothing proved anybody put them there — and nobody did:
 * this screen kept a private map of object URLs and dropped the File, so `getFile`
 * returned undefined for every page in production and every caregiver was told
 * "PAGES NOT AVAILABLE — the photos were cleared when the page reloaded", reload or
 * no reload. Prescription reading never worked from the UI while both test files
 * were green.
 *
 * So these assert the handover itself, which is the thing neither screen's own
 * tests could see.
 */
function renderPrescription() {
  return render(
    <StrictMode>
      <MemoryRouter>
        <Prescription />
      </MemoryRouter>
    </StrictMode>,
  )
}

function pick(file: File) {
  // The gallery input. All three entry points funnel into the same handler.
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

describe('adding a prescription page', () => {
  it('leaves the bytes where the analysing screen looks for them', async () => {
    renderPrescription()
    pick(stageFile('rx.png'))

    await waitFor(() => expect(readDraft().files).toHaveLength(1))
    const { id } = readDraft().files[0]

    // The whole bug in one line: this was undefined for every page ever picked.
    expect(getFile(id)).toBeInstanceOf(File)
  })

  it('releases the bytes when the page is removed', async () => {
    renderPrescription()
    pick(stageFile('rx.png'))
    await waitFor(() => expect(readDraft().files).toHaveLength(1))
    const { id } = readDraft().files[0]

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    await waitFor(() => expect(readDraft().files).toHaveLength(0))
    // Not just tidiness: these are prescription photographs, and the draft row is
    // gone, so nothing would ever drop them again.
    expect(getFile(id)).toBeUndefined()
  })
})
