import { cloneElement, Fragment, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Button, Card, Label, Row, Tag } from '../ui'
import { isEmail, isOtp, normalizePhoneInput, toE164, useSetupDraft } from './store'
import { ApiError } from '../api/client'
import { auth } from '../auth/api'
import { SESSION_KEY, useSession } from '../auth/SessionProvider'
import { useAuthRedirect } from '../auth/redirect'

/**
 * The four gated auth steps (wireframe 1a / 2a):
 *   1 phone → 2 six-digit OTP → 3 email → 4 six-digit OTP
 *
 * Extracted from Login.tsx so `/login` and the landing page's 376px auth column
 * render THE SAME machine. WIREFRAMES.md:501 specifies that the desktop landing
 * carries "the same four step cards as 1a" — with two copies, the OTP handling,
 * the server cooldown and the is_new routing would drift apart within a day.
 *
 * Real auth. The code is generated, hashed and checked by our own API
 * (api/auth/), delivered by SMS or email, and dies on use, on expiry, or after
 * five wrong tries. What is verified is the session cookie the server sets —
 * not anything this component decides.
 *
 * Step 2 creates the session; steps 3-4 attach an email to it. That order is
 * load-bearing: verifying an email with no session would mint a second,
 * phoneless identity.
 */

/** Mirrors `otp_ttl_min` in api/config.py. If that changes, change this — a code
 *  the UI still believes in is a step the caregiver cannot complete. */
const OTP_TTL_MS = 10 * 60 * 1000

type StepState = 'done' | 'active' | 'locked'

/** What went wrong, per step. `null` clears on the next attempt. */
type Err = string | null

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Try again.'
}

export function AuthSteps({
  variant = 'page',
  reveal = 'all',
  onDone,
  initialPhone,
  initialEmail,
}: {
  /** `page` = /login, own scroll and a footer pushed to the bottom.
   *  `inset` = the landing's auth column, sized by its container. */
  variant?: 'page' | 'inset'
  /** `all` draws the five cards stacked, locked ones greyed — the landing column
   *  wants that: it is a shop window, and seeing the whole shape of the signup is
   *  the point. `active` draws one card at a time under a progress rail, which is
   *  what a page whose only job is signing up should do. Four cards of disabled
   *  inputs are not information, they are a wall. */
  reveal?: 'all' | 'active'
  /** Overrides where a completed sign-in lands. Defaults to the deep-link-aware
   *  destination below, which is what /login wants. */
  onDone?: () => void
  /** Prefill for someone bounced here from `/login` — they typed it once. */
  initialPhone?: string
  initialEmail?: string
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const session = useSession()
  const { draft, patch } = useSetupDraft()
  const { redirect, arm } = useAuthRedirect()

  // The prefill wins over the draft: it is what this person typed seconds ago on
  // the other page, and the draft may be a stale number from a signup they
  // abandoned last week.
  //
  // Through `normalizePhoneInput` on the way in, because /login hands over E.164
  // and this field holds bare digits. Dropped in raw it read "+919876543210"
  // under a placeholder saying "98765 43210" — the same mismatch that field's
  // own comment records producing "+91+91…" the moment anyone touched it.
  const [phone, setPhone] = useState(
    initialPhone ? normalizePhoneInput(initialPhone) : draft.phone,
  )
  const [phoneOtp, setPhoneOtp] = useState('')
  const [email, setEmail] = useState(initialEmail || draft.email)
  const [emailOtp, setEmailOtp] = useState('')

  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState<
    null | 'phone' | 'phoneOtp' | 'email' | 'emailOtp' | 'details'
  >(null)
  const [phoneErr, setPhoneErr] = useState<Err>(null)
  const [phoneOtpErr, setPhoneOtpErr] = useState<Err>(null)
  const [emailErr, setEmailErr] = useState<Err>(null)
  const [emailOtpErr, setEmailOtpErr] = useState<Err>(null)
  const [detailsErr, setDetailsErr] = useState<Err>(null)

  /** Cooldown the server handed back. Counting from our own constant would let
   *  the button re-enable before the server would accept another send. */
  const [phoneCooldown, setPhoneCooldown] = useState(0)
  const [emailCooldown, setEmailCooldown] = useState(0)

  /** Remembered from the verify response — decides onboarding vs straight in. */
  const [isNew, setIsNew] = useState(false)

  // Sent-flags live in the draft: a reload mid-verification must not force a
  // re-send. But the draft outlives the code by weeks — localStorage has no
  // expiry and the OTP has a ten-minute one — so a bare flag is not enough. A
  // flag older than the TTL (or written before this field existed, hence null)
  // means no code is in flight, and the flow starts at the phone field again.
  // `sentNow` keeps a code the caregiver just asked for from expiring out from
  // under them the moment the clock crosses the boundary.
  const [sentNow, setSentNow] = useState({ phone: false, email: false })
  const fresh = (at: number | null) => at !== null && Date.now() - at < OTP_TTL_MS
  const phoneOtpSent = draft.phoneOtpSent && (sentNow.phone || fresh(draft.phoneOtpSentAt))
  const emailOtpSent = draft.emailOtpSent && (sentNow.email || fresh(draft.emailOtpSentAt))

  // The session is the truth about what is verified. The draft only remembers
  // what was typed, so a reload does not cost the caregiver their progress.
  const phoneVerified = session?.phone_verified ?? false
  const emailVerified = session?.email_verified ?? false

  const e164 = toE164(phone)
  const phoneStep: StepState = phoneVerified ? 'done' : 'active'
  const phoneOtpStep: StepState = phoneVerified ? 'done' : phoneOtpSent ? 'active' : 'locked'
  const emailStep: StepState = emailVerified ? 'done' : phoneVerified ? 'active' : 'locked'
  const emailOtpStep: StepState = emailVerified
    ? 'done'
    : emailOtpSent && phoneVerified
      ? 'active'
      : 'locked'

  // The caregiver's own name is the signal that step 5 is finished — it is the
  // one field with no other source. `caregivers.name` defaults to '' at signup,
  // and Settings and the Care record have been reading the fixture's "Shubh".
  const detailsDone = Boolean(session?.name?.trim())
  const detailsStep: StepState = detailsDone
    ? 'done'
    : phoneVerified && emailVerified
      ? 'active'
      : 'locked'

  const allDone = phoneVerified && emailVerified && detailsDone

  /** Where signing in should land. A deep link that bounced through the guard
   *  comes back as `state.from`, so the alert someone opened is still the
   *  screen they reach. */
  const destination = () => {
    if (isNew) return '/setup/meet'
    const from = (location.state as { from?: string } | null)?.from
    return from ?? '/home'
  }

  const finish = () => {
    if (onDone) return onDone()
    navigate(destination(), { replace: true })
  }

  // ------------------------------------------------------------------ actions

  const sendPhone = async () => {
    if (!e164 || redirect) return
    setBusy('phone')
    setPhoneErr(null)
    try {
      // Before the carrier hop: does this number already belong to someone?
      //
      // A returning caregiver who lands on /signup would otherwise get a real
      // SMS, type a real code, and only then discover at step 5 that they had
      // an account all along — having been walked through a signup that was
      // never going to create anything. Ask first, and the answer is a sentence
      // and a hop to /login with the number still in the field.
      //
      // `exists` without `has_password` is a signup that stopped after step 2.
      // That one belongs here: sending them to a login form they cannot satisfy
      // is the loop this whole change exists to break.
      const who = await auth.check(e164)
      if (who.exists && who.has_password) {
        arm({
          to: '/login',
          identifier: e164,
          message: 'You already have an account with this number. Taking you to sign in…',
        })
        return
      }

      const { resend_after_s } = await auth.start('sms', e164)
      patch({ phone: e164, phoneOtpSent: true, phoneOtpSentAt: Date.now() })
      setSentNow((n) => ({ ...n, phone: true }))
      setPhoneCooldown(resend_after_s)
    } catch (err) {
      setPhoneErr(message(err))
    } finally {
      setBusy(null)
    }
  }

  const verifyPhone = async (code: string) => {
    setBusy('phoneOtp')
    setPhoneOtpErr(null)
    try {
      const res = await auth.verify('sms', toE164(draft.phone || phone)!, code)
      setIsNew(res.is_new)
      // Seed the cache rather than refetching: the caregiver is already in hand,
      // and a round trip here is a visible stall on the one step that matters.
      queryClient.setQueryData(SESSION_KEY, res.caregiver)
    } catch (err) {
      setPhoneOtpErr(message(err))
      setPhoneOtp('')
    } finally {
      setBusy(null)
    }
  }

  const sendEmail = async () => {
    if (!isEmail(email)) return
    setBusy('email')
    setEmailErr(null)
    try {
      const { resend_after_s } = await auth.start('email', email.trim())
      patch({ email: email.trim(), emailOtpSent: true, emailOtpSentAt: Date.now() })
      setSentNow((n) => ({ ...n, email: true }))
      setEmailCooldown(resend_after_s)
    } catch (err) {
      setEmailErr(message(err))
    } finally {
      setBusy(null)
    }
  }

  const verifyEmail = async (code: string) => {
    setBusy('emailOtp')
    setEmailOtpErr(null)
    try {
      const res = await auth.verify('email', draft.email || email.trim(), code)
      queryClient.setQueryData(SESSION_KEY, res.caregiver)
    } catch (err) {
      setEmailOtpErr(message(err))
      setEmailOtp('')
    } finally {
      setBusy(null)
    }
  }

  const saveDetails = async () => {
    setBusy('details')
    setDetailsErr(null)
    try {
      const res = await auth.completeSignup(name.trim(), pw, draft.relation || undefined)
      queryClient.setQueryData(SESSION_KEY, res.caregiver)
      setPw('') // no reason to keep it in memory once the server has the hash
    } catch (err) {
      setDetailsErr(message(err))
    } finally {
      setBusy(null)
    }
  }

  // Every step, in order, with the state that decides whether it is drawn. The
  // cards are built once and rendered by either mode — two copies of these five
  // would drift the moment one of them gained a field.
  const steps = [
    {
      n: 1,
      title: 'Phone number',
      state: phoneStep,
      node: (
      <Step n={1} title="Phone number" state={phoneStep} error={redirect ? redirect.message : phoneErr}>
        <input
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          disabled={phoneVerified}
          onChange={(e) => setPhone(normalizePhoneInput(e.target.value))}
          placeholder="98765 43210"
          aria-label="Your phone number"
          className={inputCls}
        />
        {!phoneVerified && (
          <Row>
            <Button
              disabled={!e164 || busy !== null || phoneCooldown > 0 || redirect !== null}
              onClick={sendPhone}
            >
              {busy === 'phone' ? 'Sending…' : phoneOtpSent ? 'Resend OTP' : 'Send OTP'}
            </Button>
            {phone && !e164 && (
              <span className="text-sm text-muted-strong">Enter the 10-digit mobile number</span>
            )}
          </Row>
        )}
      </Step>
      ),
    },
    {
      n: 2,
      title: 'Verify phone',
      state: phoneOtpStep,
      back: phoneVerified
        ? undefined
        : {
            label: 'Change phone number',
            run: () => {
              setPhoneOtp('')
              setPhoneOtpErr(null)
              setSentNow((n) => ({ ...n, phone: false }))
              patch({ phoneOtpSent: false, phoneOtpSentAt: null })
            },
          },
      node: (
      <Step n={2} title="Verify phone" state={phoneOtpStep} error={phoneOtpErr}>
        <OtpInput
          value={phoneOtp}
          onChange={setPhoneOtp}
          disabled={phoneOtpStep !== 'active' || busy === 'phoneOtp'}
          invalid={phoneOtpErr !== null}
          label={busy === 'phoneOtp' ? 'Checking…' : 'Code sent to your phone'}
          onComplete={(code) => {
            if (isOtp(code)) void verifyPhone(code)
          }}
        />
        {/*
          No SMS is actually sent. WhatsApp needs an approved template and SMS to
          Indian numbers needs DLT registration, so the API runs with
          DEV_OTP_BYPASS_NUMBERS=* and every number takes one fixed code. Without
          saying so, a tester waits on this screen for a message that never
          arrives.

          Deliberately unconditional — not gated on the step being active, and not
          behind a build flag. Someone reading the card before requesting a code
          is exactly who needs to know no SMS is coming. Remove this line and the
          API's bypass together.
        */}
        <p className="mt-2 text-2xs text-muted-strong">
          Testing build — no SMS is sent. Enter <strong>424242</strong> for any number.
        </p>
        {phoneOtpStep === 'active' && (
          <Resend
            seconds={phoneCooldown}
            busy={busy === 'phone'}
            onResend={() => {
              setPhoneOtp('')
              setPhoneOtpErr(null)
              void sendPhone()
            }}
          />
        )}
      </Step>
      ),
    },
    {
      n: 3,
      title: 'Email address',
      state: emailStep,
      node: (
      <Step n={3} title="Email address" state={emailStep} error={emailErr}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          disabled={emailVerified || emailStep === 'locked'}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Your email address"
          className={inputCls}
        />
        {!emailVerified && emailStep === 'active' && (
          <Button
            disabled={!isEmail(email) || busy !== null || emailCooldown > 0}
            onClick={sendEmail}
          >
            {busy === 'email' ? 'Sending…' : emailOtpSent ? 'Resend code' : 'Send OTP to email'}
          </Button>
        )}
      </Step>
      ),
    },
    {
      n: 4,
      title: 'Verify email',
      state: emailOtpStep,
      back: emailVerified
        ? undefined
        : {
            label: 'Change email address',
            run: () => {
              setEmailOtp('')
              setEmailOtpErr(null)
              setSentNow((n) => ({ ...n, email: false }))
              patch({ emailOtpSent: false, emailOtpSentAt: null })
            },
          },
      node: (
      <Step n={4} title="Verify email" state={emailOtpStep} error={emailOtpErr}>
        <OtpInput
          value={emailOtp}
          onChange={setEmailOtp}
          disabled={emailOtpStep !== 'active' || busy === 'emailOtp'}
          invalid={emailOtpErr !== null}
          label={busy === 'emailOtp' ? 'Checking…' : 'Code sent to your email'}
          onComplete={(code) => {
            if (isOtp(code)) void verifyEmail(code)
          }}
        />
        {emailOtpStep === 'active' && (
          <Resend
            seconds={emailCooldown}
            busy={busy === 'email'}
            onResend={() => {
              setEmailOtp('')
              setEmailOtpErr(null)
              void sendEmail()
            }}
          />
        )}
      </Step>
      ),
    },
    {
      n: 5,
      title: 'Your details',
      state: detailsStep,
      node: (
      <Step n={5} title="Your details" state={detailsStep} error={detailsErr}>
        <input
          value={name}
          disabled={detailsStep !== 'active'}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
          aria-label="Your name"
          className={inputCls}
        />
        <input
          type="password"
          value={pw}
          disabled={detailsStep !== 'active'}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Create a password"
          // `new-password` so a manager offers to generate one rather than
          // autofilling whatever it has for this domain.
          autoComplete="new-password"
          aria-label="Create a password"
          className={inputCls}
        />
        {detailsStep === 'active' && (
          <>
            <span className="text-sm text-muted-strong">
              At least 8 characters. You will use this to sign in next time — the code
              was only to prove the number is yours.
            </span>
            <Button
              disabled={!name.trim() || pw.length < 8 || busy !== null}
              onClick={() => void saveDetails()}
            >
              {busy === 'details' ? 'Saving…' : 'Save and continue'}
            </Button>
          </>
        )}
        {detailsDone && session && (
          <span className="text-sm text-muted-strong">
            Signed in as {session.name}.
          </span>
        )}
      </Step>
      ),
    },
  ]

  const footer = (
    <div className={clsx('flex flex-col gap-3', variant === 'page' && reveal === 'all' ? 'mt-auto pt-4' : 'pt-1')}>
      <p className="text-sm leading-relaxed text-muted-strong">
        By continuing you agree to the Terms and consent to automated voice calls being placed to
        your parent.
      </p>
      {(reveal === 'all' || allDone) && (
        <Button disabled={!allDone} onClick={finish}>
          Continue
        </Button>
      )}
    </div>
  )

  // A fragment, not a wrapper: `page` relies on being a direct child of the
  // screen's flex column so the footer's mt-auto reaches the bottom of the page.
  if (reveal === 'all') {
    return (
      <>
        {steps.map((s) => (
          <Fragment key={s.n}>{s.node}</Fragment>
        ))}
        {footer}
      </>
    )
  }

  // One card at a time. The rail carries the steps that are not drawn, so the
  // shape of what is left is still visible — the thing the stacked cards were
  // doing, at a twentieth of the height.
  //
  // The LAST active step, not the first: step 1 stays `active` until the phone is
  // verified, so once the code is sent both 1 and 2 are active and `find` would
  // sit on the phone field while the rail had already moved to the code.
  const currentIndex = steps.reduce((last, s, i) => (s.state === 'active' ? i : last), -1)
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined

  return (
    <>
      <StepRail steps={steps} currentIndex={currentIndex} />
      {current ? (
        <Fragment key={current.n}>
          {cloneElement(current.node, { bare: true })}
          {current.back && (
            <button
              type="button"
              onClick={current.back.run}
              className="self-start text-sm font-semibold text-muted-strong underline"
            >
              {current.back.label}
            </button>
          )}
        </Fragment>
      ) : (
        <Card emphasis="border" className="gap-1">
          <Label>All set</Label>
          <span className="text-sm text-muted-strong">
            Phone and email verified{session?.name ? `, signed in as ${session.name}` : ''}.
          </span>
        </Card>
      )}
      {footer}
    </>
  )
}

/** The five steps as a single line: what is done, what is now, what is left.
 *  Never colour alone — a done step carries a tick, the active one carries its
 *  number and the only label on the rail. */
function StepRail({
  steps,
  currentIndex,
}: {
  steps: { n: number; title: string; state: StepState }[]
  currentIndex: number
}) {
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined
  const doneCount = steps.filter((s) => s.state === 'done').length

  return (
    <div className="flex flex-col gap-1.5">
      <Row>
        <span className="text-sm font-semibold text-ink">{current ? current.title : 'Done'}</span>
        <span className="tnum ml-auto text-sm text-muted-strong">
          Step {currentIndex >= 0 ? currentIndex + 1 : steps.length} of {steps.length}
        </span>
      </Row>
      <ol
        className="flex items-center gap-1.5"
        aria-label={`Signup progress: ${doneCount} of ${steps.length} steps done`}
      >
        {steps.map((s, i) => (
          <li
            key={s.n}
            title={s.title}
            aria-current={i === currentIndex ? 'step' : undefined}
            className={clsx(
              'h-1.5 flex-1 rounded-full transition-colors',
              // Ahead of the shown step is "still to come", even when the machine
              // also calls it active — the rail must agree with the one card drawn.
              i < currentIndex || s.state === 'done' ? 'bg-accent'
                : i === currentIndex ? 'bg-accent-2'
                : 'bg-line-strong',
            )}
          />
        ))}
      </ol>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-md text-ink outline-none placeholder:text-muted-strong focus:border-ink disabled:text-muted-strong'

function Step({
  n,
  title,
  state,
  error,
  bare = false,
  children,
}: {
  n: number
  title: string
  state: StepState
  error?: Err
  /** Drops the card's own number and title — the rail above already carries
   *  them, and printing them twice is the loudest thing on the screen. */
  bare?: boolean
  children: React.ReactNode
}) {
  return (
    <Card
      emphasis={state === 'active' ? 'border' : 'none'}
      className={clsx('gap-2', state === 'locked' && 'bg-canvas')}
      aria-disabled={state === 'locked'}
    >
      {!bare && (
      <Row>
        {state === 'done' ? <Tag>{n}</Tag> : <Tag outline>{n}</Tag>}
        <Label className="flex-1">{title}</Label>
        {state === 'done' ? (
          <span className="text-sm font-semibold">verified</span>
        ) : state === 'locked' ? (
          <span className="text-sm text-muted-strong">locked</span>
        ) : null}
      </Row>
      )}
      {children}
      {error && (
        // aria-live so the failure is announced, not just drawn — the caregiver
        // may well be looking at their phone's lock screen, not at this.
        <p role="alert" aria-live="polite" className="text-sm font-semibold text-ink">
          {error}
        </p>
      )}
    </Card>
  )
}

/** Six single-character boxes, as drawn. Paste of a whole code works too. */
function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  label,
}: {
  value: string
  onChange: (v: string) => void
  onComplete: (v: string) => void
  disabled?: boolean
  invalid?: boolean
  label: string
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const chars = value.padEnd(6, ' ').slice(0, 6).split('')

  const set = (i: number, char: string) => {
    const digits = char.replace(/\D/g, '')
    if (!digits) return
    const next = (value.padEnd(6, ' ').slice(0, i) + digits + value.slice(i + digits.length))
      .replace(/\s/g, '')
      .slice(0, 6)
    onChange(next)
    const focus = Math.min(i + digits.length, 5)
    refs.current[focus]?.focus()
    if (next.length === 6) onComplete(next)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5" role="group" aria-label={label}>
        {chars.map((c, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            value={c.trim()}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label={`${label}, digit ${i + 1}`}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Backspace') return
              e.preventDefault()
              if (c.trim()) {
                // clear this box only — the digits after it survive
                onChange((value.slice(0, i) + ' ' + value.slice(i + 1)).trimEnd())
              } else if (i > 0) {
                onChange((value.slice(0, i - 1) + ' ' + value.slice(i)).trimEnd())
                refs.current[i - 1]?.focus()
              }
            }}
            className={clsx(
              'min-w-0 flex-1 rounded-md border bg-paper py-2 text-center text-lg font-semibold outline-none focus:border-ink disabled:bg-surface',
              // A wrong code has to look wrong. Weight, not colour — the rest of
              // this UI reads in greyscale and so must this.
              invalid ? 'border-[1.5px] border-ink' : 'border-line-strong',
            )}
          />
        ))}
      </div>
      <span className="text-sm text-muted-strong">{label}</span>
    </div>
  )
}

/** Counts down the server's own cooldown, so the two cannot drift apart. */
function Resend({
  seconds,
  busy,
  onResend,
}: {
  seconds: number
  busy?: boolean
  onResend: () => void
}) {
  const [left, setLeft] = useState(seconds)

  useEffect(() => setLeft(seconds), [seconds])

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  return (
    <Row>
      {left > 0 ? (
        <span className="text-sm text-muted-strong">Resend in 0:{String(left).padStart(2, '0')}</span>
      ) : (
        <button
          type="button"
          disabled={busy}
          className="text-sm font-semibold underline disabled:opacity-50"
          onClick={onResend}
        >
          {busy ? 'Sending…' : 'Resend code'}
        </button>
      )}
    </Row>
  )
}
