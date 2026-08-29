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
 */

type Div = { className?: string; children?: ReactNode }

export function Card({
  className,
  children,
  emphasis,
}: Div & { emphasis?: 'none' | 'border' | 'rule' }) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-2 rounded-lg border bg-surface p-3',
        emphasis === 'border' && 'border-[1.5px] border-ink bg-paper',
        emphasis === 'rule' && 'border-line-strong border-l-[3px] border-l-ink',
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
    <div className={clsx('text-[9px] font-bold tracking-[0.09em] text-muted uppercase', className)}>
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
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] whitespace-nowrap',
        on ? 'border-ink bg-ink text-white' : 'border-line-strong bg-paper text-ink',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

export function Tag({ children, outline, className }: Div & { outline?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-extrabold tracking-wide',
        outline ? 'border border-ink bg-paper text-ink' : 'bg-ink text-white',
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
  variant?: 'primary' | 'outline'
  disabled?: boolean
  onClick?: () => void
  href?: string
}) {
  const cls = clsx(
    'inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-center text-[12px] font-semibold',
    variant === 'primary' ? 'bg-ink text-white' : 'border border-ink bg-transparent text-ink',
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
        'rounded-md border border-line-strong bg-paper px-2.5 py-2 text-[12px]',
        value ? 'text-ink' : 'text-muted',
        className,
      )}
    >
      {value ?? placeholder}
    </div>
  )
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
        'flex items-center justify-center rounded-md border border-line-strong text-center text-[11px] text-muted',
        className,
      )}
      style={{
        backgroundImage:
          'repeating-linear-gradient(45deg,#f1f1ef,#f1f1ef 6px,#e6e6e2 6px,#e6e6e2 12px)',
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
  unknown: 'not known',
  pending: 'waiting',
}

const SEVERITY_LABEL: Record<Severity, string> = {
  none: 'noted',
  watch: 'watch',
  red: 'red',
}

function dotClass(kind: 'filled' | 'hollow' | 'empty') {
  return clsx(
    'inline-block size-2 shrink-0 rounded-full',
    kind === 'filled' && 'bg-ink',
    kind === 'hollow' && 'border-[1.5px] border-ink bg-paper',
    kind === 'empty' && 'bg-[#c9c9c3]',
  )
}

/** Five dose states, never colour alone — the label always renders. */
export function DoseStatusChip({ status }: { status: DoseStatus }) {
  const kind = status === 'confirmed' ? 'filled' : status === 'deferred' ? 'empty' : 'hollow'
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <span className={dotClass(kind)} />
      <span
        className={clsx(
          status === 'missed' || status === 'no_answer' || status === 'unknown'
            ? 'font-semibold'
            : 'text-muted-strong',
        )}
      >
        {DOSE_LABEL[status]}
      </span>
    </span>
  )
}

export function SeverityChip({ severity }: { severity: Severity }) {
  if (severity === 'red') return <Tag>red</Tag>
  if (severity === 'watch') return <Tag outline>watch</Tag>
  return <Label>{SEVERITY_LABEL.none}</Label>
}

/** Upcoming / neutral dot for timeline rows. */
export function Dot({ kind }: { kind: 'filled' | 'hollow' | 'empty' }) {
  return <span className={dotClass(kind)} />
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
      <div className="text-[12px] font-semibold">{message}</div>
      <div className="text-[11px] text-muted-strong">
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
      <div className="text-[13px] font-bold">{title}</div>
      <div className="max-w-xs text-[11px] text-muted-strong">{body}</div>
      {action}
    </Card>
  )
}
