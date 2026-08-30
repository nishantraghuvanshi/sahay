import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Login from './Login'
import Signup from './Signup'
import { auth } from '../../auth/api'
import { ApiError } from '../../api/client'
import { clearAuthDraft } from '../../setup/store'

/**
 * The two wrong-page dead ends, and the way out of each.
 *
 * A caregiver who has never signed up types a password into `/login`; a
 * caregiver who signed up last month starts `/signup`. Neither problem is
 * solvable on the page they are on, and the old build said nothing that pointed
 * at the other one — "that phone or email and password do not match" to someone
 * who has no password, and a real SMS to someone who already has an account.
 *
 * What these pin is the pair of hops, and that the identifier survives them.
 * Retyping a phone number to get past a screen that redirected you is the part
 * people give up at.
 */

vi.mock('../../auth/api', () => ({
  auth: {
    login: vi.fn(),
    check: vi.fn(),
    start: vi.fn(),
    verify: vi.fn(),
    completeSignup: vi.fn(),
  },
}))

vi.mock('../../auth/SessionProvider', () => ({
  SESSION_KEY: ['session'],
  useSession: () => null,
}))

const login = vi.mocked(auth.login)
const check = vi.mocked(auth.check)
const start = vi.mocked(auth.start)

/** Renders both auth pages under one router so a redirect is observable. */
function renderAuth(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const seen = { path: initial }

  function Probe() {
    const location = useLocation()
    seen.path = location.pathname
    return null
  }

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Probe />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return seen
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // The phone number and the OTP sent-flags live in a module variable, not in
  // storage, so clearing localStorage leaves the previous test's step 2 open and
  // step 1 never renders.
  clearAuthDraft()
})

describe('a new caregiver who tries to log in', () => {
  it('is told to sign up, and lands there with the number already typed', async () => {
    login.mockRejectedValue(new ApiError('No account yet.', 'no_account'))
    const seen = renderAuth('/login')

    await userEvent.type(screen.getByLabelText(/phone or email/i), '+919876543210')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'whatever-they-guessed')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    // The sentence comes first and stays up long enough to read.
    expect(await screen.findByRole('alert')).toHaveTextContent(/no account yet/i)
    expect(seen.path).toBe('/login')

    await waitFor(() => expect(seen.path).toBe('/signup'), { timeout: 4000 })
    // Step 1 of signup, prefilled — the phone field takes the local form.
    expect(screen.getByLabelText(/your phone number/i)).toHaveValue('9876543210')
  })

  it('does not say the password was wrong — there is no password', async () => {
    login.mockRejectedValue(new ApiError('No account yet.', 'no_account'))
    renderAuth('/login')

    await userEvent.type(screen.getByLabelText(/phone or email/i), '+919876543210')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/password is not right|do not match/i)
  })

  it('sends a half-finished signup back to finish it, not round the login loop', async () => {
    login.mockRejectedValue(new ApiError('Never finished.', 'signup_incomplete'))
    const seen = renderAuth('/login')

    await userEvent.type(screen.getByLabelText(/phone or email/i), '+919876543210')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(seen.path).toBe('/signup'), { timeout: 4000 })
  })
})

describe('an existing caregiver who tries to sign up', () => {
  it('is told to log in, and never gets an SMS', async () => {
    check.mockResolvedValue({ unknown: false, exists: true, has_password: true })
    const seen = renderAuth('/signup')

    await userEvent.type(screen.getByLabelText(/your phone number/i), '9876543210')
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already have an account/i)
    // The point of checking before sending: no code was issued to someone who
    // did not need one, and no ten-minute wait was spent finding that out.
    expect(start).not.toHaveBeenCalled()

    await waitFor(() => expect(seen.path).toBe('/login'), { timeout: 4000 })
    expect(screen.getByLabelText(/phone or email/i)).toHaveValue('+919876543210')
  })

  it('lets a half-finished signup carry on, since that is where it finishes', async () => {
    check.mockResolvedValue({ unknown: false, exists: true, has_password: false })
    start.mockResolvedValue({ resend_after_s: 30 })
    const seen = renderAuth('/signup')

    await userEvent.type(screen.getByLabelText(/your phone number/i), '9876543210')
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }))

    await waitFor(() => expect(start).toHaveBeenCalledWith('sms', '+919876543210'))
    expect(seen.path).toBe('/signup')
  })

  it('sends the code as usual for a number nobody has claimed', async () => {
    check.mockResolvedValue({ unknown: false, exists: false, has_password: false })
    start.mockResolvedValue({ resend_after_s: 30 })
    renderAuth('/signup')

    await userEvent.type(screen.getByLabelText(/your phone number/i), '9876543210')
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }))

    await waitFor(() => expect(start).toHaveBeenCalledWith('sms', '+919876543210'))
  })

  it('falls back to sending when the check declines to answer', async () => {
    // Throttled. `unknown` must never be read as "no account" — the worst
    // outcome here is a caregiver blocked from a signup they are entitled to.
    check.mockResolvedValue({ unknown: true, exists: false, has_password: false })
    start.mockResolvedValue({ resend_after_s: 30 })
    renderAuth('/signup')

    await userEvent.type(screen.getByLabelText(/your phone number/i), '9876543210')
    await userEvent.click(screen.getByRole('button', { name: /send otp/i }))

    await waitFor(() => expect(start).toHaveBeenCalledWith('sms', '+919876543210'))
  })
})
