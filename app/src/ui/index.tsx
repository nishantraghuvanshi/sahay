import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { DoseStatus, Severity } from '../api/types'

/**
 * Shared primitives. Status is never colour-only: every Dot / Chip / Tag that carries a
 * state renders a shape AND a word, and colour is layered on top of a mark that already
 * works in greyscale (verify: DevTools → Rendering → Achromatopsia).
 *
 * Three marks, no more: filled = taken / done / confirmed · outlined = missed / needs
 * action · muted = upcoming / pending / locked.
 */

type Div = { className?: string; children?: ReactNode }

export function Card({
  className,
  children,
  emphasis,
}: Div & { emphasis?: 'none' | 'border' | 'rule' | 'danger' }) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-2.5 rounded-2xl border p-4 transition-shadow duration-200',
        emphasis === 'border' && 'border-[1.5px] border-ink bg-paper shadow-[var(--shadow-lift)]',
        emphasis === 'rule' &&
          'border-line-strong border-l-[4px] border-l-accent bg-surface shadow-[var(--shadow-card)]',
        emphasis === 'danger' &&
          'border-danger/35 border-l-[4px] border-l-danger bg-danger-soft shadow-[var(--shadow-card)]',
        (!emphasis || emphasis === 'none') &&
          'border-line-strong bg-surface shadow-[var(--shadow-card)]',
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
    <div
      className={clsx(
        'text-2xs font-bold tracking-[0.08em] text-muted-strong uppercase',
        className,
      )}
    >
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
        'inline-flex min-h-[34px] items-center rounded-full border px-3.5 py-1 text-xs font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-out)]',
        on
          ? 'border-ink bg-ink text-paper'
          : 'border-line-strong bg-paper text-ink hover:border-ink',
        onClick && 'active:scale-[0.97]',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

/** A metadata / status pill. `tone` layers colour onto the shape + word (never colour alone). */
export function Tag({
  children,
  outline,
  tone = 'ink',
  className,
}: Div & { outline?: boolean; tone?: 'ink' | 'danger' | 'warn' | 'accent' }) {
  const solid: Record<string, string> = {
    ink: 'bg-ink text-paper',
    danger: 'bg-danger text-white',
    warn: 'bg-warn text-white',
    accent: 'bg-accent text-white',
  }
  const outlined: Record<string, string> = {
    ink: 'border border-ink bg-paper text-ink',
    danger: 'border border-danger bg-danger-soft text-danger',
    warn: 'border border-warn bg-warn-soft text-warn',
    accent: 'border border-accent bg-accent-soft text-accent',
  }
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-2xs font-extrabold tracking-wide',
        outline ? outlined[tone] : solid[tone],
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
  variant?: 'primary' | 'outline' | 'accent'
  disabled?: boolean
  onClick?: () => void
  href?: string
}) {
  const cls = clsx(
    'inline-flex min-h-[44px] items-center justify-center rounded-full px-5 py-2.5 text-center text-sm font-semibold transition-[transform,background-color,box-shadow,border-color] duration-150 ease-[var(--ease-out)]',
    !disabled && 'active:scale-[0.98]',
    variant === 'primary' && 'bg-ink text-paper hover:bg-ink-soft',
    variant === 'accent' && 'bg-accent text-white hover:bg-accent-2',
    variant === 'outline' && 'border-[1.5px] border-ink bg-transparent text-ink hover:bg-ink/[0.05]',
    disabled && 'cursor-not-allowed opacity-40',
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
        'rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-sm',
        value ? 'text-ink' : 'text-muted',
        className,
      )}
    >
      {value ?? placeholder}
    </div>
  )
}

/** Skeleton bar — also a meter when `fill` is set. */
export function Bar({
  width = '100%',
  fill,
  className,
}: {
  width?: string
  fill?: number
  className?: string
}) {
  return (
    <div
      className={clsx('h-2.5 overflow-hidden rounded-full', fill === undefined && 'kv-shimmer', className)}
      style={{ width, ...(fill !== undefined ? { background: 'var(--color-fill)' } : {}) }}
    >
      {fill !== undefined && (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-[var(--ease-out)]"
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
      )}
    </div>
  )
}

/** Hatched placeholder — images, scans, logos. */
export function Placeholder({ className, children }: Div) {
  return (
    <div
      className={clsx(
        'flex items-center justify-center rounded-lg border border-line-strong text-center text-xs text-muted',
        className,
      )}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg,#f4ecd9,#f4ecd9 6px,#eadfc9 6px,#eadfc9 12px)',
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

type DotTone = 'ink' | 'accent' | 'danger' | 'warn'

function dotClass(kind: 'filled' | 'hollow' | 'empty', tone: DotTone = 'ink') {
  const solid: Record<DotTone, string> = {
    ink: 'bg-ink',
    accent: 'bg-accent',
    danger: 'bg-danger',
    warn: 'bg-warn',
  }
  const ring: Record<DotTone, string> = {
    ink: 'border-ink',
    accent: 'border-accent',
    danger: 'border-danger',
    warn: 'border-warn',
  }
  return clsx(
    'inline-block size-2.5 shrink-0 rounded-full',
    kind === 'filled' && solid[tone],
    kind === 'hollow' && clsx('border-2 bg-paper', ring[tone]),
    kind === 'empty' && 'bg-fill-empty',
  )
}

/** Four dose states, never colour alone — the word always renders. */
export function DoseStatusChip({ status }: { status: DoseStatus }) {
  const kind = status === 'confirmed' ? 'filled' : status === 'deferred' ? 'empty' : 'hollow'
  const tone: DotTone =
    status === 'confirmed' ? 'accent' : status === 'missed' ? 'danger' : status === 'no_answer' ? 'warn' : 'ink'
  const emphatic = status === 'missed' || status === 'no_answer'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={dotClass(kind, tone)} />
      <span
        className={clsx(
          emphatic && status === 'missed' && 'font-semibold text-danger',
          emphatic && status === 'no_answer' && 'font-semibold text-warn',
          !emphatic && 'text-muted-strong',
        )}
      >
        {DOSE_LABEL[status]}
      </span>
    </span>
  )
}

export function SeverityChip({ severity }: { severity: Severity }) {
  if (severity === 'red') return <Tag tone="danger">red</Tag>
  if (severity === 'watch') return <Tag tone="warn" outline>watch</Tag>
  return <Label>{SEVERITY_LABEL.none}</Label>
}

/** Upcoming / neutral dot for timeline rows. */
export function Dot({ kind, tone = 'ink' }: { kind: 'filled' | 'hollow' | 'empty'; tone?: DotTone }) {
  return <span className={dotClass(kind, tone)} />
}

/* ------------------------------------------------------------ page states */

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <Bar key={i} width={`${90 - i * 14}%`} />
      ))}
      <span className="sr-only">Loading</span>
    </div>
  )
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong at our end.'
  return (
    <Card emphasis="danger">
      <Label>Not loaded</Label>
      <div className="text-sm font-semibold">{message}</div>
      <div className="text-xs text-muted-strong">
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
    <Card className="items-center gap-2.5 border-dashed py-10 text-center">
      <div className="font-display text-lg font-semibold">{title}</div>
      <div className="max-w-xs text-xs leading-relaxed text-muted-strong">{body}</div>
      {action}
    </Card>
  )
}

/* Signature components live in their own file; re-exported so screens keep one import. */
export * from './signature'
