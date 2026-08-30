import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Meet from './Meet'
import { VoiceSession } from '../../lib/voiceSession'

/**
 * The left rail is a contract with the agent, not decoration: what it holds is
 * what goes into `{drug_name}` and `{dose_timing}` in the prompt the server
 * composes once, at open. So the two things worth pinning are that a call
 * cannot start half-configured, and that the rail cannot be edited once it has
 * — a control that still looked live would be lying about what the voice is
 * saying.
 */

vi.mock('../../auth/SessionProvider', () => ({
  useSession: () => ({
    id: 'c1',
    name: 'Shubh',
    phone_e164: '+919812345678',
    email: null,
    relationship: null,
    phone_verified: true,
    email_verified: true,
  }),
}))

/** A VoiceSession that connects and then simply stays live, like a real one. */
vi.mock('../../lib/voiceSession', () => {
  const VoiceSession = vi.fn(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
    this.opts = opts
    this.start = vi.fn(async () => {
      ;(opts.onState as (s: string) => void)('connecting')
    })
    this.stop = vi.fn(() => {
      ;(opts.onState as (s: string) => void)('idle')
      ;(opts.onClosed as (() => void) | undefined)?.()
    })
  })
  return { VoiceSession }
})

const constructed = vi.mocked(VoiceSession)

function renderMeet() {
  return render(
    <MemoryRouter>
      <Meet />
    </MemoryRouter>,
  )
}

const startButton = () => screen.getByRole('button', { name: 'Start the call' })

async function configure(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Medicine'), 'Metformin')
  await user.click(screen.getByRole('button', { name: 'After meal' }))
  await user.click(screen.getByRole('button', { name: 'Lunch' }))
}

describe('Meet — the call configuration rail', () => {
  beforeEach(() => {
    constructed.mockClear()
  })

  it('gates the call until a medicine, a relation and a meal are picked', async () => {
    const user = userEvent.setup()
    renderMeet()

    expect(startButton()).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Medicine'), 'Metformin')
    expect(startButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'After meal' }))
    expect(startButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Lunch' }))
    expect(startButton()).toBeEnabled()
  })

  it('sends the picked dose to the agent as an outbound reminder call', async () => {
    const user = userEvent.setup()
    renderMeet()

    await configure(user)
    await user.click(screen.getByRole('button', { name: 'English' }))
    await user.click(startButton())

    expect(constructed).toHaveBeenCalledTimes(1)
    expect(constructed.mock.calls[0][0]).toMatchObject({
      direction: 'outbound',
      drugName: 'Metformin',
      mealRelation: 'after',
      meal: 'lunch',
      language: 'en',
      phone: '+919812345678',
    })
  })

  it('locks every control while the call is running, and frees them after', async () => {
    const user = userEvent.setup()
    renderMeet()

    await configure(user)
    await user.click(startButton())

    expect(screen.getByLabelText('Medicine')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Before meal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dinner' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'English' })).toBeDisabled()
    expect(screen.getByText('Locked')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'End the call' }))

    expect(screen.getByLabelText('Medicine')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Dinner' })).toBeEnabled()
    expect(startButton()).toBeEnabled()
  })
})
