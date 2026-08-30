import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import Parent from './Parent'

const cta = () => screen.getByRole('button', { name: /upload prescription/i })

const renderParent = () =>
  render(
    <MemoryRouter>
      <Parent />
    </MemoryRouter>,
  )

/** Fill the five fields the CTA gates on, the way a caregiver would. */
async function fillAll(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Name/i), 'Sharma')
  await user.type(screen.getByLabelText(/^Age/i), '68')
  await user.click(screen.getByRole('button', { name: 'Mother' }))
  await user.type(screen.getByLabelText(/the agent calls this/i), '9876543210')
  await user.click(screen.getByRole('button', { name: /Hindi/ }))
}

describe('the parent form CTA', () => {
  it('starts disabled with all five fields outstanding', () => {
    renderParent()
    expect(cta()).toBeDisabled()
    expect(screen.getByText('5 left')).toBeInTheDocument()
  })

  it('names what is still missing, not just how many', async () => {
    const user = userEvent.setup()
    renderParent()

    await user.type(screen.getByLabelText(/^Name/i), 'Sharma')
    await user.type(screen.getByLabelText(/^Age/i), '68')
    await user.type(screen.getByLabelText(/the agent calls this/i), '9876543210')

    // The two left are chips, not text boxes — the case where a bare count
    // leaves the caregiver hunting for a field they believe they filled in.
    expect(screen.getByText(/Still needed: relation to you and language/)).toBeInTheDocument()
  })

  it('counts a phone that is not a valid Indian mobile as missing, and says so', async () => {
    const user = userEvent.setup()
    renderParent()

    await user.type(screen.getByLabelText(/the agent calls this/i), '12345')

    expect(screen.getByText(/a valid 10-digit phone/)).toBeInTheDocument()
    expect(cta()).toBeDisabled()
  })

  it('enables once name, age, relation, phone and language are in', async () => {
    const user = userEvent.setup()
    renderParent()
    await fillAll(user)
    expect(screen.queryByText(/\d+ left/)).not.toBeInTheDocument()
    expect(cta()).toBeEnabled()
  })
})
