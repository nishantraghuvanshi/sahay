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
} from '../ui'
import { useCalls, useEscalations, useObservations } from '../api/hooks'
import { relativeTime } from '../lib/schedule'
import type { CallSession, Escalation, Observation, Severity } from '../api/types'

/**
 * Wireframe 1s "What Mom said" / 2j — FR-25.
 *
 * The whole screen is one rule: the rows are quotations. Text is rendered exactly as the
 * `observations` table stores it — Hindi/Hinglish included, no transliteration, no
 * translation, no truncation, no line clamp. Everything else on the row (time, severity,
 * kind, provenance) is metadata that already exists in the record.
 *
 * 🔑 There is deliberately NO score here: no mood chart, no sentiment percentage, no
 * wellbeing index. The client cut them from these frames and LANE-C-APP.md keeps them cut —
 * "a number nobody can trace back to a sentence is not evidence".
 */

type SeverityFilter = 'all' | Severity
type RangeFilter = 'day' | 'month' | 'year' | 'all'

const SEVERITY_FILTERS: { key: SeverityFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'red', label: 'Red' },
  { key: 'watch', label: 'Watch' },
  { key: 'none', label: 'Noted' },
]

const RANGE_FILTERS: { key: RangeFilter; label: string; window: string }[] = [
  { key: 'day', label: 'Day', window: 'today' },
  { key: 'month', label: 'Month', window: 'this month' },
  { key: 'year', label: 'Year', window: 'this year' },
  { key: 'all', label: 'All time', window: 'all time' },
]

const KIND_LABEL: Record<Observation['kind'], string> = {
  symptom: 'symptom',
  mood: 'mood',
  note: 'note',
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
 * Provenance, matched honestly or not at all.
 *
 * An escalation carries no `call_session_id` of its own, so the only link we can stand
 * behind is: this red observation came off a call, and exactly one escalation was sent
 * while that same call was live. Zero matches, or more than one, renders no link — a
 * guessed link on an alerts screen is worse than none.
 */
const ESCALATION_GRACE_MS = 2 * 60_000

function escalationFor(
  observation: Observation,
  escalations: Escalation[],
  calls: CallSession[],
): Escalation | null {
  if (observation.severity !== 'red' || !observation.call_session_id) return null
  const call = calls.find((c) => c.id === observation.call_session_id)
  if (!call) return null

  const from = new Date(call.started_at).getTime()
  const to = (call.ended_at ? new Date(call.ended_at).getTime() : from) + ESCALATION_GRACE_MS

  const during = escalations.filter((e) => {
    if (e.patient_id !== observation.patient_id || !e.sent_at) return false
    const sent = new Date(e.sent_at).getTime()
    return sent >= from && sent <= to
  })
  return during.length === 1 ? during[0] : null
}

export default function Observations() {
  const observations = useObservations()
  const escalations = useEscalations()
  const calls = useCalls()

  // All time by default, so the screen is never mysteriously empty on first open.
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [range, setRange] = useState<RangeFilter>('all')

  if (observations.isLoading) return <LoadingBlock rows={5} />
  if (observations.error) {
    return <ErrorBlock error={observations.error} onRetry={() => observations.refetch()} />
  }

  const now = new Date()
  const all = [...(observations.data ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )

  const start = rangeStart(range, now)
  const inRange = start ? all.filter((o) => new Date(o.created_at) >= start) : all
  const rows = severity === 'all' ? inRange : inRange.filter((o) => o.severity === severity)

  const count = (key: SeverityFilter) =>
    key === 'all' ? inRange.length : inRange.filter((o) => o.severity === key).length

  const windowWord = RANGE_FILTERS.find((r) => r.key === range)!.window

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {/* ------------------------------------------------------ what this screen is */}
      <Card className="gap-1.5">
        <Label>What she said</Label>
        <div className="text-[13px] leading-snug font-bold">
          Her own words, as she said them.
        </div>
        <div className="text-[11px] leading-relaxed text-muted-strong">
          Every line below is stored exactly as it was heard — nothing is translated,
          shortened, summarised or scored. The words are the record.
        </div>
      </Card>

      {/* -------------------------------------------------------------- the filters */}
      <div className="flex flex-col gap-2">
        <Row className="flex-wrap gap-1.5">
          {SEVERITY_FILTERS.map((f) => (
            <Chip key={f.key} on={severity === f.key} onClick={() => setSeverity(f.key)}>
              {f.label} {count(f.key)}
            </Chip>
          ))}
        </Row>
        <Row className="flex-wrap gap-1.5">
          {RANGE_FILTERS.map((f) => (
            <Chip key={f.key} on={range === f.key} onClick={() => setRange(f.key)}>
              {f.label}
            </Chip>
          ))}
        </Row>
        <Row>
          <Label className="flex-1">
            {rows.length} {rows.length === 1 ? 'line' : 'lines'} · {windowWord} · newest first
          </Label>
        </Row>
      </div>

      <Divider />

      {/* --------------------------------------------------------------- the record */}
      {all.length === 0 ? (
        <EmptyBlock
          title="Nothing has been flagged"
          body="She has not said anything we needed to keep. When she does, it appears here word for word."
        />
      ) : rows.length === 0 ? (
        <EmptyBlock
          title="Nothing in this view"
          body={`No ${severity === 'all' ? '' : `${severity === 'none' ? 'noted' : severity} `}lines ${windowWord}. Widen the range to see the rest of the record.`}
          action={
            <Button
              variant="outline"
              onClick={() => {
                setSeverity('all')
                setRange('all')
              }}
            >
              Show everything
            </Button>
          }
        />
      ) : (
        rows.map((o) => (
          <ObservationRow
            key={o.id}
            observation={o}
            now={now}
            escalation={escalationFor(o, escalations.data ?? [], calls.data ?? [])}
          />
        ))
      )}
    </div>
  )
}

/** One quotation. The sentence is the dominant element; everything else is small. */
function ObservationRow({
  observation,
  escalation,
  now,
}: {
  observation: Observation
  escalation: Escalation | null
  now: Date
}) {
  const at = new Date(observation.created_at)

  return (
    <Card emphasis={observation.severity === 'red' ? 'rule' : 'none'} className="gap-2">
      <Row className="flex-wrap gap-2">
        <SeverityChip severity={observation.severity} />
        <Label>{KIND_LABEL[observation.kind]}</Label>
        <Label className="ml-auto text-right">
          {absoluteLabel(at, now)} · {relativeHint(at, now)}
        </Label>
      </Row>

      {/* Verbatim. No clamp, no truncate, no ellipsis — the full sentence always renders. */}
      <blockquote
        lang="hi"
        className={clsx(
          'text-[15px] leading-relaxed break-words hyphens-none whitespace-pre-wrap sm:text-[16px]',
          observation.severity === 'red' ? 'font-bold' : 'font-semibold',
        )}
      >
        “{observation.text}”
      </blockquote>

      {(observation.call_session_id || escalation) && (
        <>
          <Divider />
          <Row className="flex-wrap gap-x-3 gap-y-1">
            {observation.call_session_id && (
              <Link
                to={`/calls/${observation.call_session_id}`}
                className="text-[11px] font-semibold underline"
              >
                Heard on this call
              </Link>
            )}
            {escalation && (
              <Link to={`/alerts/${escalation.id}`} className="text-[11px] font-semibold underline">
                Escalated to you · {escalation.level}
              </Link>
            )}
          </Row>
        </>
      )}
    </Card>
  )
}
