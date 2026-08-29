import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { DoseStatus, Severity } from '../api/types'

/**
 * Primitives ported 1:1 from the wireframe CSS atoms (wireframe/*.dc.html):
 * .c Card · .r Row · .chip · .tag · .dot · .btn/.ob Button · .in Field · .lbl Label · .g Bar
 *
 * Rule carried over from the wireframes: status is never colour-only. Every Dot renders
 * a text label beside it, so the screen survives a greyscale screen recording and a
 * colour-blind viewer (LANE-C demo readiness).
 *
 * Palette F adds hue ON TOP of those marks — it never replaces the shape or the label.
 * Verify with DevTools > Rendering > Emulate vision deficiency > Achromatopsia: every
 * dose status, severity and step state must still be distinguishable.
 */

/** Status hue. `ink` is the default; the rest are layered onto an existing mark. */
export type Tone = 'ink' | 'accent' | 'ok' | 'warn' | 'danger'

const TONE_FILL: Record<Tone, string> = {
  ink: 'bg-ink text-white',
  accent: 'bg-accent text-white',
  ok: 'bg-ok text-white',
  warn: 'bg-warn text-white',
  danger: 'bg-danger text-white',
}

const TONE_OUTLINE: Record<Tone, string> = {
  ink: 'border-ink bg-paper text-ink',
  accent: 'border-accent bg-accent-soft text-accent',
  ok: 'border-ok bg-accent-soft text-ok',
  warn: 'border-warn bg-warn-soft text-warn',
  danger: 'border-danger bg-danger-soft text-danger',
}

type Div = { className?: string; children?: ReactNode }

export function Card({
  className,
  children,
  emphasis,
}: Div & { emphasis?: 'none' | 'border' | 'rule' | 'alert' }) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-2 rounded-lg border bg-surface p-3 shadow-card',
        emphasis === 'border' && 'border-[1.5px] border-ink bg-paper',
        emphasis === 'rule' && 'border-line-strong border-l-[3px] border-l-ink',
        emphasis === 'alert' && 'border-line-strong border-l-[3px] border-l-danger bg-danger-soft',
        (!emphasis || emphasis === 'none') && 'border-line-strong',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Row({ className, children }: Div) {
  return <div className={clsx('flex items-center gap-2', className)}>{children}</div>
}

export function Label({ className, children }: Div) {
  return (
    <div className={clsx('text-2xs font-bold tracking-[0.09em] text-muted uppercase', className)}>
      {children}
    </div>
  )
}

export function Chip({
  children,
  on,
  className,
  onClick,
}: Div & { on?: boolean; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const } : {})}
      {...(onClick && on !== undefined ? { 'aria-pressed': on } : {})}
      onClick={onClick}
      className={clsx(
        'inline-flex min-h-[32px] items-center rounded-full border px-3 py-1.5 text-sm whitespace-nowrap',
        onClick && 'cursor-pointer transition-colors duration-150 ease-out',
        on
          ? 'border-ink bg-ink text-white'
          : clsx('border-line-strong bg-paper text-ink', onClick && 'hover:border-ink hover:bg-line'),
        className,
      )}
    >
      {children}
    </Tag>
  )
}

export function Tag({
  children,
  outline,
  tone = 'ink',
  className,
}: Div & { outline?: boolean; tone?: Tone }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-2 py-1 text-2xs font-extrabold tracking-wide',
        outline ? clsx('border', TONE_OUTLINE[tone]) : TONE_FILL[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Button({
  children,
  variant = 'primary',
  disabled,
  onClick,
  href,
  className,
}: Div & {
  variant?: 'primary' | 'outline' | 'quiet' | 'accent'
  disabled?: boolean
  onClick?: () => void
  href?: string
}) {
  const cls = clsx(
    'inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-center text-base font-semibold',
    'transition-colors duration-150 ease-out',
    variant === 'primary' && 'bg-ink text-white hover:bg-ink-soft active:bg-ink',
    variant === 'accent' && 'bg-accent text-white hover:brightness-110 active:brightness-95',
    variant === 'outline' && 'border border-ink bg-transparent text-ink hover:bg-line',
    variant === 'quiet' && 'bg-transparent font-medium text-muted-strong hover:bg-line hover:text-ink',
    disabled && 'pointer-events-none opacity-40',
    className,
  )
  if (href && !disabled) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cls}>
      {children}
    </button>
  )
}

export function Field({
  value,
  placeholder,
  className,
}: {
  value?: string
  placeholder?: string
  className?: string
}) {
  return (
    <div
      className={clsx(
        'rounded-md border border-line-strong bg-paper px-2.5 py-2 text-base',
        value ? 'text-ink' : 'text-muted',
        className,
      )}
    >
      {value ?? placeholder}
    </div>
  )
}

/**
 * The one text control. Before this, the same class string was retyped in eight places
 * at three different font sizes with inconsistent focus rings (Login, Parent, Schedule,
 * MedicinesEdit). `Field` above is its read-only twin.
 */
export function Input({
  as = 'input',
  className,
  ...rest
}: { as?: 'input' | 'textarea'; className?: string } & React.ComponentPropsWithoutRef<'input'> &
  React.ComponentPropsWithoutRef<'textarea'>) {
  const cls = clsx(
    'w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-base text-ink',
    'transition-colors duration-150 ease-out outline-none placeholder:text-muted',
    'focus:border-accent focus:ring-[3px] focus:ring-accent-soft',
    'disabled:pointer-events-none disabled:opacity-50',
    className,
  )
  if (as === 'textarea') return <textarea className={cls} {...rest} />
  return <input className={cls} {...rest} />
}

/** Skeleton bar (.g) — also used as a meter when `fill` is set. */
export function Bar({ width = '100%', fill, className }: { width?: string; fill?: number; className?: string }) {
  return (
    <div className={clsx('h-2 rounded bg-fill', className)} style={{ width }}>
      {fill !== undefined && (
        <div className="h-2 rounded bg-ink" style={{ width: `${Math.round(fill * 100)}%` }} />
      )}
    </div>
  )
}

/** Hatched placeholder (.im) — images, scans, logos. */
export function Placeholder({ className, children }: Div) {
  return (
    <div
      className={clsx(
        'flex items-center justify-center rounded-md border border-line-strong text-center text-sm text-muted',
        className,
      )}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg,#f4ecdd,#f4ecdd 6px,#e8dcc6 6px,#e8dcc6 12px)',
      }}
    >
      {children}
    </div>
  )
}

export function Divider({ className }: { className?: string }) {
  return <div className={clsx('h-px bg-line', className)} />
}

/* ---------------------------------------------------------------- status */

const DOSE_LABEL: Record<DoseStatus, string> = {
  confirmed: 'taken',
  deferred: 'deferred',
  missed: 'missed',
  no_answer: 'no answer',
}

const SEVERITY_LABEL: Record<Severity, string> = {
  none: 'noted',
  watch: 'watch',
  red: 'red',
}

function dotClass(kind: 'filled' | 'hollow' | 'empty', tone: Tone = 'ink') {
  return clsx(
    'inline-block size-2 shrink-0 rounded-full',
    kind === 'filled' && (tone === 'ink' ? 'bg-ink' : 'bg-ok'),
    kind === 'hollow' &&
      clsx(
        'border-[1.5px] bg-paper',
        tone === 'warn' ? 'border-warn' : tone === 'danger' ? 'border-danger' : 'border-ink',
      ),
    kind === 'empty' && 'bg-fill-empty',
  )
}

/** Four dose states, never colour alone — the label always renders. */
export function DoseStatusChip({ status }: { status: DoseStatus }) {
  const kind = status === 'confirmed' ? 'filled' : status === 'deferred' ? 'empty' : 'hollow'
  // `no_answer` is warn, not danger: unreachable is `unknown`, never `missed` (WIREFRAMES §8.13).
  const tone: Tone =
    status === 'confirmed' ? 'ok' : status === 'missed' ? 'danger' : status === 'no_answer' ? 'warn' : 'ink'
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={dotClass(kind, tone)} />
      <span
        className={clsx(
          status === 'missed' && 'font-semibold text-danger',
          status === 'no_answer' && 'font-semibold text-warn',
          (status === 'confirmed' || status === 'deferred') && 'text-muted-strong',
        )}
      >
        {DOSE_LABEL[status]}
      </span>
    </span>
  )
}

export function SeverityChip({ severity }: { severity: Severity }) {
  if (severity === 'red') return <Tag tone="danger">red</Tag>
  if (severity === 'watch') return <Tag outline tone="warn">watch</Tag>
  return <Label>{SEVERITY_LABEL.none}</Label>
}

/** Upcoming / neutral dot for timeline rows. */
export function Dot({ kind, tone }: { kind: 'filled' | 'hollow' | 'empty'; tone?: Tone }) {
  return <span className={dotClass(kind, tone)} />
}

/* ------------------------------------------------------------ page states */

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <Bar key={i} width={`${90 - i * 18}%`} />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  )
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong at our end.'
  return (
    <Card emphasis="rule">
      <Label>Not loaded</Label>
      <div className="text-base font-semibold">{message}</div>
      <div className="text-sm text-muted-strong">
        Nothing has been lost — the record is on our servers. This screen just could not read it.
      </div>
      {onRetry && (
        <Row>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </Row>
      )}
    </Card>
  )
}

export function EmptyBlock({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card className="items-center gap-2 border-dashed py-8 text-center">
      <div className="text-md font-bold">{title}</div>
      <div className="max-w-xs text-sm text-muted-strong">{body}</div>
      {action}
    </Card>
  )
}

/* Signature components live in their own file; re-exported so screens keep one import. */
export * from './signature'
