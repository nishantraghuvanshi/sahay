import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyBlock,
  ErrorBlock,
  Label,
  LoadingBlock,
  Row,
  SeverityChip,
  Tag,
  useParentLanguage,
} from '../ui'
import { useEscalations, useObservations } from '../api/hooks'
import { relativeTime } from '../lib/schedule'
import type { Escalation, EscalationChannel, Observation, Priority } from '../api/types'

/**
 * FR-26 · PR-3 · wireframe `1h` (feed) / `2g` (list half of the split).
 *
 * The whole point of this screen is one string. `escalations.reason` holds the literal rule
 * that fired — `rule: chest complaint with age over 40` — and it is rendered as the row's
 * headline, at the largest type in the row, exactly as the row stores it. Never "P1" on its
 * own, never softened into "chest pain detected", never paraphrased into a diagnosis. That
 * substitution is what turns a judgment that looks subjective into one anybody can audit,
 * and it is the answer to "how do you know it's a P1?".
 *
 * The `P1` tag is metadata *about* the rule, not a replacement for it. Priority is never
 * carried by colour: the letter is always spelled out, and the legend at the foot says in
 * words what each level means.
 *
 * The desktop wireframe `2g` shows a list/detail split. Only the list lives here — the
 * detail is its own route (`/alerts/:id`), and this screen links into it.
 */

type LevelFilter = 'all' | Priority
type RangeFilter = 'day' | 'month' | 'year' | 'all'

const LEVEL_FILTERS: { key: LevelFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'P1', label: 'P1' },
  { key: 'P2', label: 'P2' },
  { key: 'P3', label: 'P3' },
]

/** Date filter sits above the level filter — "did anything happen this month?" is the
 *  question people actually arrive with (annotation on frame `1h`). */
const RANGE_FILTERS: { key: RangeFilter; label: string; window: string }[] = [
  { key: 'day', label: 'Day', window: 'today' },
  { key: 'month', label: 'Month', window: 'this month' },
  { key: 'year', label: 'Year', window: 'this year' },
  { key: 'all', label: 'All time', window: 'all time' },
]

/** PRD §12.1. Said in words so the level never depends on the badge's fill alone. */
const LEVEL_MEANING: Record<Priority, string> = {
  P1: 'Someone should act now. You are messaged and called, and a handoff link is made.',
  P2: 'You are messaged the same day, with a handoff link. Not an emergency.',
  P3: 'Kept on the record and messaged to you. Nothing needs doing right now.',
}

const CHANNEL_PHRASE: Record<EscalationChannel, string> = {
  whatsapp: 'by WhatsApp',
  sms: 'by SMS',
  call: 'by phone call',
}

/** Calendar-based, not a rolling window — "Day" means today, not the last 24 hours. */
function rangeStart(range: RangeFilter, now: Date): Date | null {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (range === 'day') return d
  if (range === 'month') {
    d.setDate(1)
    return d
  }
  if (range === 'year') {
    d.setMonth(0, 1)
    return d
  }
  return null
}

/** 'Today 1:36 PM' · 'Fri 8:33 AM' · '12 Jul 6:05 PM' — always an absolute clock time. */
function absoluteLabel(at: Date, now: Date): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === now.toDateString()) return `Today ${time}`
  const ageDays = (now.getTime() - at.getTime()) / 86_400_000
  if (ageDays < 7 && ageDays > 0) {
    return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
  }
  const date = at.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
  return `${date} ${time}`
}

/** The relative hint beside it. Minutes and hours from the shared helper, days after that. */
function relativeHint(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1440) return relativeTime(at, now)
  const days = Math.floor(minutes / 1440)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/**
 * An escalation that has not been sent yet is *current*, not historical — it stays visible in
 * every date range rather than falling out of "Day" because it has no timestamp to sort on.
 */
const sentTime = (e: Escalation): number | null =>
  e.sent_at ? new Date(e.sent_at).getTime() : null

function inRange(e: Escalation, start: Date | null): boolean {
  if (!start) return true
  const t = sentTime(e)
  return t === null || t >= start.getTime()
}

/**
 * The sentence the rule fired on, matched honestly or not at all.
 *
 * An escalation carries no `observation_id`, so the only claim we can stand behind is: one
 * red observation for this patient was written in the couple of minutes before the message
 * went out. Zero matches, or more than one, renders no quote — a guessed quote beside a rule
 * string is worse than none, and the rule string is the evidence either way.
 */
const QUOTE_WINDOW_MS = 3 * 60_000

function triggeringQuote(e: Escalation, observations: Observation[]): Observation | null {
  const sent = sentTime(e)
  if (sent === null) return null
  const near = observations.filter((o) => {
    if (o.patient_id !== e.patient_id || o.severity !== 'red') return false
    const at = new Date(o.created_at).getTime()
    return at <= sent && sent - at <= QUOTE_WINDOW_MS
  })
  return near.length === 1 ? near[0] : null
}

export default function Alerts() {
  const escalations = useEscalations()
  const observations = useObservations()

  // All time by default, so the screen is never mysteriously empty on first open.
  const [level, setLevel] = useState<LevelFilter>('all')
  const [range, setRange] = useState<RangeFilter>('all')

  if (escalations.isLoading) return <LoadingBlock rows={4} />
  if (escalations.error) {
    return <ErrorBlock error={escalations.error} onRetry={() => escalations.refetch()} />
  }

  const now = new Date()
  const all = [...(escalations.data ?? [])].sort((a, b) =>
    (b.sent_at ?? '9999').localeCompare(a.sent_at ?? '9999'),
  )

  const start = rangeStart(range, now)
  const dated = all.filter((e) => inRange(e, start))
  const rows = level === 'all' ? dated : dated.filter((e) => e.level === level)

  const levelCount = (key: LevelFilter) =>
    key === 'all' ? dated.length : dated.filter((e) => e.level === key).length

  const rangeCount = (key: RangeFilter) => {
    const from = rangeStart(key, now)
    return all.filter((e) => inRange(e, from) && (level === 'all' || e.level === level)).length
  }

  const windowWord = RANGE_FILTERS.find((r) => r.key === range)!.window
  const levelsPresent = (['P1', 'P2', 'P3'] as Priority[]).filter((p) =>
    all.some((e) => e.level === p),
  )

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {/* ------------------------------------------------------- what this screen is */}
      <div className="flex flex-col gap-1">
        <Row className="items-baseline gap-2">
          <h1 className="flex-1 text-lg font-semibold">Alerts</h1>
          <Label>
            {all.length} {all.length === 1 ? 'alert' : 'alerts'}
          </Label>
        </Row>
        <p className="text-sm leading-relaxed text-muted-strong">
          Each alert leads with the rule that raised it, written out in full. Nothing here is a
          diagnosis — the rule is the reason, and you can check it against what she said.
        </p>
      </div>

      {/* ------------------------------------------------------------------ filters */}
      <div className="flex flex-col gap-2">
        {/* date range first — frame 1h puts it above severity */}
        <Row className="flex-wrap gap-1.5">
          <Label className="mr-0.5">Show</Label>
          {RANGE_FILTERS.map((f) => (
            <Chip key={f.key} on={range === f.key} onClick={() => setRange(f.key)}>
              {f.label} · {rangeCount(f.key)}
            </Chip>
          ))}
        </Row>
        <Row className="flex-wrap gap-1.5">
          <Label className="mr-0.5">Level</Label>
          {LEVEL_FILTERS.map((f) => (
            <Chip key={f.key} on={level === f.key} onClick={() => setLevel(f.key)}>
              {f.label} · {levelCount(f.key)}
            </Chip>
          ))}
        </Row>
        <Label>
          {rows.length} {rows.length === 1 ? 'alert' : 'alerts'} · {windowWord} · newest first
        </Label>
      </div>

      <Divider />

      {/* -------------------------------------------------------------- the record */}
      {all.length === 0 ? (
        /* Reassurance, not a fault. An empty alerts screen is the good day. */
        <EmptyBlock
          title="Nothing has needed anyone's attention"
          body="No rule has fired, so nobody has been messaged. This screen is meant to stay empty — when something does need you, the rule that raised it appears here in full."
        />
      ) : rows.length === 0 ? (
        /* Deliberately different from the above: the record is not empty, this view is. */
        <Card emphasis="border" className="items-start gap-2">
          <Label>Nothing in this view</Label>
          <div className="text-md font-semibold">
            No {level === 'all' ? '' : `${level} `}alerts {windowWord}.
          </div>
          <p className="text-sm leading-relaxed text-muted-strong">
            The record is not empty — {all.length} {all.length === 1 ? 'alert has' : 'alerts have'}{' '}
            been raised in total. Widen the range to see {all.length === 1 ? 'it' : 'them'}.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setLevel('all')
              setRange('all')
            }}
          >
            Show everything
          </Button>
        </Card>
      ) : (
        rows.map((e) => (
          <AlertRow
            key={e.id}
            escalation={e}
            quote={triggeringQuote(e, observations.data ?? [])}
            now={now}
          />
        ))
      )}

      {/* --------------------------------------------------------------- legend */}
      {levelsPresent.length > 0 && (
        <Card className="gap-2">
          <Label>What the levels mean</Label>
          {levelsPresent.map((p) => (
            <Row key={p} className="items-start gap-2">
              <span className="w-8 shrink-0 pt-px">
                <Tag outline={p !== 'P1'}>{p}</Tag>
              </span>
              <span className="min-w-0 flex-1 text-sm break-words text-muted-strong">
                {LEVEL_MEANING[p]}
              </span>
            </Row>
          ))}
        </Card>
      )}
    </section>
  )
}

/**
 * One `escalations` row.
 *
 * Reading order is deliberate: level, then the rule, then when, then who was told. The rule
 * string gets the largest type on the row and stays that way at every width — the desktop
 * breakpoint grows it rather than demoting it to a caption.
 */
function AlertRow({
  escalation,
  quote,
  now,
}: {
  escalation: Escalation
  quote: Observation | null
  now: Date
}) {
  const parentLang = useParentLanguage()
  const at = escalation.sent_at ? new Date(escalation.sent_at) : null
  const status = escalation.delivery_status

  return (
    <Card emphasis={escalation.level === 'P1' ? 'danger' : 'none'} className="gap-2">
      <Row className="flex-wrap gap-2">
        <Tag outline={escalation.level !== 'P1'} tone={escalation.level === 'P1' ? 'danger' : escalation.level === 'P2' ? 'warn' : 'ink'}>{escalation.level}</Tag>
        <Label>why this was flagged</Label>
        <Label className="ml-auto text-right">
          {at ? `${absoluteLabel(at, now)} · ${relativeHint(at, now)}` : 'not sent yet'}
        </Label>
      </Row>

      {/* PR-3 — the literal rule text, verbatim from the row, dominant on the card. */}
      <p
        className={clsx(
          'text-lg leading-snug break-words hyphens-none whitespace-pre-wrap sm:text-lg',
          escalation.level === 'P1' ? 'font-semibold' : '',
        )}
      >
        {escalation.reason}
      </p>

      <p className="text-2xs leading-relaxed text-muted-strong">
        Triggered on the words she used. No interpretation, no diagnosis.
      </p>

      {quote && (
        <Row className="items-start gap-2">
          <span className="shrink-0 pt-0.5">
            <SeverityChip severity={quote.severity} />
          </span>
          <blockquote
            lang={parentLang}
            className="min-w-0 flex-1 border-l-2 border-line-strong pl-2 text-base leading-relaxed break-words"
          >
            “{quote.text}”
          </blockquote>
        </Row>
      )}

      <Divider />

      {/* Told to — plain sentence, no icon to decode. */}
      <div className="text-sm leading-relaxed break-words">
        <span className="font-semibold">
          {at ? 'Told to' : 'Queued for'} {escalation.sent_to}
        </span>{' '}
        {CHANNEL_PHRASE[escalation.channel]}
        {at && ` at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
        {' · '}
        <span className={clsx(status === 'delivered' ? 'text-muted-strong' : 'font-semibold')}>
          {status ?? (at ? 'delivery not confirmed' : 'not sent yet')}
        </span>
      </div>

      <Link to={`/alerts/${escalation.id}`} className="text-sm underline">
        {escalation.intake_record_id ? 'Open the intake record' : 'Open this alert'} ›
      </Link>
    </Card>
  )
}
