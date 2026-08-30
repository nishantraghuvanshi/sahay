import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { Severity } from '../api/types'

/**
 * Signature components — the pieces that give the product's own ideas a form.
 *
 * The atoms in ./index.tsx are the wireframe's vocabulary. These are not in the
 * wireframes: they exist because the three things Kinvox is actually for — what she
 * said, the rule that fired, and the fields it already knew — were all rendering as
 * grey body text indistinguishable from a settings label.
 *
 * The motif is the line: one hairline is the call, the thing connecting a child in
 * one city to a parent in another. It is the wordmark, the spine of the day thread,
 * and the rule between sections.
 */

/* ------------------------------------------------------------------ wordmark */

/** "Kinvox" with the i-dot lifted onto the hairline that runs under the word. */
export function Wordmark({ className, size = 15 }: { className?: string; size?: number }) {
  return (
    <span
      className={clsx('relative inline-block pb-[5px] leading-none', className)}
      style={{ fontFamily: 'var(--font-display)', fontSize: size }}
    >
      <span className="tracking-[-0.01em]">Kinvox</span>
      <span className="absolute inset-x-0 bottom-0 h-px bg-current" />
      <span
        className="absolute bottom-[-1.5px] size-[3px] rounded-full bg-accent"
        style={{ left: size * 0.38 }}
      />
    </span>
  )
}

/* ---------------------------------------------------------------- QuoteBlock */

/**
 * Her words, set as the largest thing on the screen.
 *
 * The severity spine and the chip beside the attribution both carry the level, so
 * the hue is never the only signal. `lang` matters: index.css binds :lang(hi) to
 * IBM Plex Sans Devanagari, and without it a Hindi quote silently falls back to a
 * system face while everything around it is set properly.
 */
export function QuoteBlock({
  children,
  severity = 'none',
  attribution,
  lang,
  size = 'lg',
  className,
}: {
  children: ReactNode
  severity?: Severity
  attribution?: ReactNode
  lang?: string
  size?: 'lg' | 'sm'
  className?: string
}) {
  return (
    <figure className={clsx('relative m-0 pt-1 pl-5', className)}>
      <span
        className={clsx(
          'absolute inset-y-0 left-0 w-[3px] rounded-full',
          severity === 'red' ? 'bg-danger' : severity === 'watch' ? 'bg-warn' : 'bg-line-strong',
        )}
        aria-hidden="true"
      />
      <span
        className="pointer-events-none absolute -top-4 left-3 z-0 leading-none text-line-strong select-none"
        style={{ fontFamily: 'var(--font-display)', fontSize: size === 'lg' ? 76 : 54 }}
        aria-hidden="true"
      >
        &ldquo;
      </span>
      <blockquote
        lang={lang}
        className={clsx(
          'relative z-10 m-0 font-light',
          size === 'lg' ? 'text-2xl leading-[1.28]' : 'text-lg leading-snug',
        )}
        style={{ fontFamily: lang ? undefined : 'var(--font-display)' }}
      >
        {children}
      </blockquote>
      {attribution && (
        <figcaption className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-strong">
          {attribution}
        </figcaption>
      )}
    </figure>
  )
}

/* -------------------------------------------------------------------- Thread */

/**
 * The day roll-up as the motif made literal: a hairline with the status dots sitting
 * on it. `gutter` must clear the widest rendered time — at the 14px body size a
 * "08:31 AM" wraps in anything narrower.
 */
export function Thread({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('relative', className)}>
      <div className="relative flex flex-col">{children}</div>
    </div>
  )
}

/* --------------------------------------------------------------- IntakeMeter */

/**
 * The hero claim, which had no representation in the UI at all (TRD §10).
 *
 * Twelve cells: filled = inherited from the record, outlined = asked on this call,
 * hollow = still unknown. A cold-start line asks all twelve, of a frightened caller,
 * at 2 AM.
 */
export function IntakeMeter({
  known,
  asked,
  total = 12,
  className,
}: {
  known: number
  asked: number
  total?: number
  className?: string
}) {
  const cells = Array.from({ length: total }, (_, i) =>
    i < known ? 'known' : i < known + asked ? 'asked' : 'unknown',
  )
  return (
    <div className={clsx('flex flex-col gap-2.5', className)}>
      <div
        className="grid max-w-[320px] grid-cols-6 gap-1"
        role="img"
        aria-label={`${known} of ${total} intake fields already known from the record, ${asked} asked on this call`}
      >
        {cells.map((kind, i) => (
          <span
            key={i}
            className={clsx(
              'h-6 rounded-[3px] border-[1.5px]',
              kind === 'known' && 'border-ink bg-ink',
              kind === 'asked' && 'border-ink bg-transparent',
              kind === 'unknown' && 'border-fill-empty bg-transparent',
            )}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-strong">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border-[1.5px] border-ink bg-ink" />
          from the record
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border-[1.5px] border-ink" />
          asked on the call
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border-[1.5px] border-fill-empty" />
          still unknown
        </span>
      </div>
    </div>
  )
}
