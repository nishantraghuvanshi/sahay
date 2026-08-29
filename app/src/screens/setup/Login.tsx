import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Button, Card, Label, Row, Tag } from '../../ui'
import { isEmail, isOtp, toE164, useSetupDraft } from '../../setup/store'

/**
 * Wireframe 1a / 2a — four gated steps on one screen:
 *   1 phone → 2 six-digit OTP → 3 email → 4 six-digit OTP
 * No social login. Each step unlocks the next; earlier steps stay visible and editable
 * so the caregiver can see how far they are without a progress bar.
 *
 * Mock auth: any six digits verify. Nothing here talks to a real identity provider yet.
 */

type StepState = 'done' | 'active' | 'locked'

export default function Login() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()

  const [phone, setPhone] = useState(draft.phone)
  const [phoneOtp, setPhoneOtp] = useState('')
  const [email, setEmail] = useState(draft.email)
  const [emailOtp, setEmailOtp] = useState('')
  // Sent-flags live in the draft: a reload mid-verification must not force a re-send.
  const phoneOtpSent = draft.phoneOtpSent || draft.phoneVerified
  const emailOtpSent = draft.emailOtpSent || draft.emailVerified

  const e164 = toE164(phone)
  const phoneStep: StepState = draft.phoneVerified ? 'done' : 'active'
  const phoneOtpStep: StepState = draft.phoneVerified ? 'done' : phoneOtpSent ? 'active' : 'locked'
  const emailStep: StepState = draft.emailVerified
    ? 'done'
    : draft.phoneVerified
      ? 'active'
      : 'locked'
  const emailOtpStep: StepState = draft.emailVerified
    ? 'done'
    : emailOtpSent && draft.phoneVerified
      ? 'active'
      : 'locked'

  const allDone = draft.phoneVerified && draft.emailVerified

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-3 p-5">
      <div className="grid size-12 place-items-center rounded-xl bg-ink text-[18px] font-bold text-white">
        K
      </div>
      <h1 className="text-[22px] leading-tight font-bold">
        Keep an eye on
        <br />
        your parent&rsquo;s meds
      </h1>
      <p className="text-[12px] text-muted-strong">
        We call them. You only hear what matters.
      </p>

      <Step n={1} title="Phone number" state={phoneStep}>
        <input
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          disabled={draft.phoneVerified}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
          aria-label="Your phone number"
          className={inputCls}
        />
        {!draft.phoneVerified && (
          <Row>
            <Button
              disabled={!e164}
              onClick={() => patch({ phone: e164!, phoneOtpSent: true })}
            >
              {phoneOtpSent ? 'Resend OTP' : 'Send OTP'}
            </Button>
            {phone && !e164 && (
              <span className="text-[11px] text-muted-strong">
                10 digits, or start with +country code
              </span>
            )}
          </Row>
        )}
      </Step>

      <Step n={2} title="Verify phone" state={phoneOtpStep}>
        <OtpInput
          value={phoneOtp}
          onChange={setPhoneOtp}
          disabled={phoneOtpStep !== 'active'}
          label="Code sent to your phone"
          onComplete={(code) => {
            if (isOtp(code)) patch({ phoneVerified: true })
          }}
        />
        {phoneOtpStep === 'active' && <Resend onResend={() => setPhoneOtp('')} />}
      </Step>

      <Step n={3} title="Email address" state={emailStep}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          disabled={draft.emailVerified || emailStep === 'locked'}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Your email address"
          className={inputCls}
        />
        {!draft.emailVerified && emailStep === 'active' && (
          <Button
            disabled={!isEmail(email)}
            onClick={() => patch({ email: email.trim(), emailOtpSent: true })}
          >
            {emailOtpSent ? 'Resend code' : 'Send OTP to email'}
          </Button>
        )}
      </Step>

      <Step n={4} title="Verify email" state={emailOtpStep}>
        <OtpInput
          value={emailOtp}
          onChange={setEmailOtp}
          disabled={emailOtpStep !== 'active'}
          label="Code sent to your email"
          onComplete={(code) => {
            if (isOtp(code)) patch({ emailVerified: true })
          }}
        />
        {emailOtpStep === 'active' && <Resend onResend={() => setEmailOtp('')} />}
      </Step>

      <div className="mt-auto flex flex-col gap-3 pt-4">
        <p className="text-[10px] leading-relaxed text-muted">
          By continuing you agree to the Terms and consent to automated voice calls being placed to
          your parent.
        </p>
        <Button disabled={!allDone} onClick={() => navigate('/setup/parent')}>
          Continue
        </Button>
      </div>
    </main>
  )
}

const inputCls =
  'w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink disabled:text-muted-strong'

function Step({
  n,
  title,
  state,
  children,
}: {
  n: number
  title: string
  state: StepState
  children: React.ReactNode
}) {
  return (
    <Card
      emphasis={state === 'active' ? 'border' : 'none'}
      className={clsx('gap-2', state === 'locked' && 'opacity-60')}
      aria-disabled={state === 'locked'}
    >
      <Row>
        {state === 'done' ? <Tag>{n}</Tag> : <Tag outline>{n}</Tag>}
        <Label className="flex-1">{title}</Label>
        {state === 'done' ? (
          <span className="text-[11px] font-semibold">verified</span>
        ) : state === 'locked' ? (
          <span className="text-[11px] text-muted">locked</span>
        ) : null}
      </Row>
      {children}
    </Card>
  )
}

/** Six single-character boxes, as drawn. Paste of a whole code works too. */
function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  label,
}: {
  value: string
  onChange: (v: string) => void
  onComplete: (v: string) => void
  disabled?: boolean
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
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-paper py-2 text-center text-[15px] font-semibold outline-none focus:border-ink disabled:bg-surface"
          />
        ))}
      </div>
      <span className="text-[10px] text-muted">{label} — any six digits work in this build</span>
    </div>
  )
}

function Resend({ onResend }: { onResend: () => void }) {
  const [left, setLeft] = useState(24)
  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  return (
    <Row>
      {left > 0 ? (
        <span className="text-[11px] text-muted">
          Resend in 0:{String(left).padStart(2, '0')}
        </span>
      ) : (
        <button
          type="button"
          className="text-[11px] font-semibold underline"
          onClick={() => {
            setLeft(24)
            onResend()
          }}
        >
          Resend code
        </button>
      )}
    </Row>
  )
}
