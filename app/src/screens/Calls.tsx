import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import {
  Card,
  Chip,
  Divider,
  EmptyBlock,
  ErrorBlock,
  Label,
  LoadingBlock,
  Row,
  Tag,
} from '../ui'
import { useCalls, useCareRecord, useDoseHistory, useObservations } from '../api/hooks'
import { relativeTime } from '../lib/schedule'
import type { CallSession } from '../api/types'

/**
 * Wireframe `1j` / `2h` — the call log. FR-26, and the visible half of NFR-9:
 * every call carries a stored transcript and a safety verdict, and both are stated on the
 * row rather than implied by an icon.
 *
 * 🔑 There is deliberately NO sentiment on this screen: no sentiment dot, no mood score, no
 * "how the call felt" number. The client cut all of it from these frames. The transcript is
 * the record; a score nobody can trace back to a sentence is not evidence.
 *
 * The other rule the frames insist on: a call nobody answered must never look like a short
 * call. `no_answer` renders as words — "Nobody picked up" — and never as a duration.
 */

type FilterKey = 'all' | 'out' | 'in' | 'no_answer'

const FILTERS: { key: FilterKey; label: string; match: (c: CallSession) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'out', label: 'Agent called', match: (c) => c.direction === 'out' },
  { key: 'in', label: 'They called', match: (c) => c.direction === 'in' },
  { key: 'no_answer', label: 'No answer', match: (c) => c.status === 'no_answer' },
]

/** Statuses the Care API can store, said in words. Anything unknown falls back to the raw value. */
const STATUS_WORD: Record<string, string> = {
  completed: 'Call completed',
  no_answer: 'Nobody picked up',
  in_progress: 'Call in progress',
  failed: 'The call did not connect',
  cancelled: 'Call cancelled',
}

const statusWord = (call: CallSession): string =>
  STATUS_WORD[call.status] ?? call.status.replace(/_/g, ' ')

/** NFR-9 evidence, as a word — never a colour, never a tick. */
const safetyWord = (pass: boolean | null): string =>
  pass === true ? 'passed' : pass === false ? 'failed' : 'not recorded'

const answered = (call: CallSession) => call.status !== 'no_answer'

/** Wall-clock span of the session, or null when the call never closed. */
function spanMs(call: CallSession): number | null {
  if (!call.ended_at) return null
  const ms = new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()
  return ms > 0 ? ms : null
}

/** '44 s' · '1 min 4 s' · '2 min' */
function spanWords(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest} s`
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** 'Today 1:35 PM' · 'Fri 8:33 AM' · '12 Jul 6:05 PM' — always an absolute clock time. */
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

function relativeHint(at: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1440) return relativeTime(at, now)
  const days = Math.floor(minutes / 1440)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export default function Calls() {
  const calls = useCalls()
  const doses = useDoseHistory()
  const observations = useObservations()
  const record = useCareRecord()
  const [filter, setFilter] = useState<FilterKey>('all')

  if (calls.isLoading) return <LoadingBlock rows={5} />
  if (calls.error) return <ErrorBlock error={calls.error} onRetry={() => calls.refetch()} />

  const now = new Date()
  const all = [...(calls.data ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at))

  const patient = record.data?.patient
  const who = patient ? `${patient.name}${patient.honorific ? `-${patient.honorific}` : ''}` : null

  const doseEvents = doses.data ?? []
  const observationRows = observations.data ?? []
  const produced = (call: CallSession) => ({
    doses: doseEvents.filter((d) => d.call_session_id === call.id).length,
    observations: observationRows.filter((o) => o.call_session_id === call.id).length,
  })

  const count = (key: FilterKey) => all.filter(FILTERS.find((f) => f.key === key)!.match).length
  const rows = all.filter(FILTERS.find((f) => f.key === filter)!.match)

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {/* ------------------------------------------------------------- header */}
      <div className="flex flex-col gap-1">
        <Row className="items-baseline gap-2">
          <h1 className="flex-1 text-lg font-bold">Calls</h1>
          <Label>
            {all.length} {all.length === 1 ? 'call' : 'calls'}
          </Label>
        </Row>
        <p className="text-sm leading-relaxed text-muted-strong">
          Every call {who ? `with ${who} ` : ''}is kept: what was said, what it changed in the
          record, and whether the agent stayed inside its safety rules. Newest first.
        </p>
      </div>

      {(doses.error || observations.error) && (
        <p className="text-sm text-muted-strong">
          The counts of what each call produced could not be loaded just now. The calls below are
          unchanged — open one to see its record.
        </p>
      )}

      {/* ------------------------------------------------------------ filters */}
      {all.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Row className="flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <Chip key={f.key} on={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label} · {count(f.key)}
              </Chip>
            ))}
          </Row>
          <Label>
            A call that rang out is both an agent call and a no-answer, so these counts overlap.
          </Label>
        </div>
      )}

      {/* --------------------------------------------------------- the log */}
      {all.length === 0 ? (
        <EmptyBlock
          title="No calls yet"
          body={`No call has been placed${who ? ` to ${who}` : ''} and none has come in. The first one appears here the moment it ends, with its transcript.`}
        />
      ) : rows.length === 0 ? (
        <Card className="py-6 text-center">
          <div className="text-base text-muted-strong">
            No calls in that view. {all.length} in total.
          </div>
        </Card>
      ) : (
        rows.map((call) => (
          <CallRow key={call.id} call={call} now={now} who={who} produced={produced(call)} />
        ))
      )}

      {/* ---------------------------------------------------- what a row means */}
      {all.length > 0 && (
        <Card className="gap-1.5">
          <Label>Why every row says “safety check”</Label>
          <p className="text-sm leading-relaxed text-muted-strong">
            The agent is not allowed to diagnose, to change a dose, or to talk a worrying symptom
            down. Each call is checked against those rules and the verdict is stored with it — in
            words, so it survives a greyscale recording. A call with no transcript still carries a
            verdict.
          </p>
        </Card>
      )}
    </section>
  )
}

/**
 * One `call_sessions` row.
 *
 * Inbound is the hero: the parent reaching us first is the moment this product exists for, so
 * it gets the bordered card, the filled tag and a sentence of its own. Outbound is the routine
 * check-in and reads quieter — but the difference is carried by the words "They called" /
 * "We called", not by the border alone.
 */
function CallRow({
  call,
  now,
  who,
  produced,
}: {
  call: CallSession
  now: Date
  who: string | null
  produced: { doses: number; observations: number }
}) {
  const at = new Date(call.started_at)
  const inbound = call.direction === 'in'
  const ms = spanMs(call)
  const wasAnswered = answered(call)

  const producedWords =
    produced.doses === 0 && produced.observations === 0
      ? 'Nothing was written to the record'
      : [
          produced.doses > 0
            ? `${produced.doses} dose ${produced.doses === 1 ? 'record' : 'records'}`
            : null,
          produced.observations > 0
            ? `${produced.observations} ${produced.observations === 1 ? 'observation' : 'observations'}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')

  return (
    <Link
      to={`/calls/${call.id}`}
      className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
    >
      <Card emphasis={inbound ? 'border' : 'none'} className="gap-2">
        {/* direction · when · how long */}
        <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
          {inbound ? <Tag>they called</Tag> : <Tag outline>we called</Tag>}
          <span className="text-md font-bold">{absoluteLabel(at, now)}</span>
          <span className="text-sm text-muted">{relativeHint(at, now)}</span>
          <span className="ml-auto shrink-0 text-sm font-semibold">
            {!wasAnswered ? 'no answer' : ms !== null ? spanWords(ms) : 'still open'}
          </span>
        </Row>

        {/* the sentence — what actually happened, in words */}
        <div
          className={clsx(
            'text-base leading-snug break-words',
            inbound ? 'font-semibold' : 'text-muted-strong',
          )}
        >
          {!wasAnswered
            ? `Nobody picked up. We called${who ? ` ${who}` : ''} and the line was never answered, so nothing was said and nothing was heard.`
            : inbound
              ? `${who ?? 'They'} called us. The agent answered and stayed on the line.`
              : `We called${who ? ` ${who}` : ''} for the scheduled check-in.`}
        </div>

        {/* honest about the ring: this is time the line was open, not time anyone spoke */}
        {!wasAnswered && ms !== null && (
          <div className="text-sm text-muted">
            The line was open {spanWords(ms)} — ringing, not talking.
          </div>
        )}

        <Divider />

        {/* what it produced · what it stored · NFR-9 verdict */}
        <div className="flex flex-col gap-1">
          <Row className="flex-wrap gap-x-2 gap-y-1">
            <Label>Produced</Label>
            <span className="min-w-0 flex-1 text-sm break-words">{producedWords}</span>
          </Row>
          <Row className="flex-wrap gap-x-2 gap-y-1">
            <Label>Transcript</Label>
            <span className="min-w-0 flex-1 text-sm break-words">
              {call.transcript === null
                ? 'none stored — there was no conversation'
                : 'stored, word for word'}
            </span>
          </Row>
          <Row className="flex-wrap gap-x-2 gap-y-1">
            <Label>Safety check</Label>
            <span
              className={clsx(
                'min-w-0 flex-1 text-sm break-words',
                call.safety_pass === false && 'font-bold',
              )}
            >
              {safetyWord(call.safety_pass)}
            </span>
          </Row>
          <Row className="flex-wrap gap-x-2 gap-y-1">
            <Label>Status</Label>
            <span className="min-w-0 flex-1 text-sm break-words">{statusWord(call)}</span>
          </Row>
        </div>

        <span className="text-sm font-semibold underline">Open this call</span>
      </Card>
    </Link>
  )
}
