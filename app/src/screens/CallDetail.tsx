import { Link, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Card,
  Divider,
  DoseStatusChip,
  ErrorBlock,
  Label,
  LoadingBlock,
  Row,
  SeverityChip,
  Tag,
  useParentLanguage,
} from '../ui'
import { useCalls, useCareRecord, useDoseHistory, useObservations } from '../api/hooks'
import type { CallSession, DoseEvent, Medication, Observation } from '../api/types'

/**
 * Wireframe `1j` / `2h`, detail pane — one call, whole.
 *
 * This screen is the NFR-9 exhibit: the stored transcript, rendered verbatim, and the safety
 * verdict beside it. Hindi and Hinglish are shown exactly as the `call_sessions.transcript`
 * column holds them — no translation, no transliteration, no truncation, no line clamp.
 *
 * 🔑 No sentiment anywhere: no sentiment dot per turn, no sentiment-through-the-call chart, no
 * mood score. The client cut every one of them from these frames. The words are the record.
 *
 * The fixture stores no per-line timestamps, so no per-line timestamp is shown. Inventing one
 * would make the transcript look more precise than the record actually is.
 */

const AGENT_SPEAKER = 'agent'

interface Turn {
  speaker: string
  isAgent: boolean
  text: string
}

/**
 * The column is newline-separated `speaker: text`.
 *
 * Split on newlines; a line whose start looks like a speaker label (a short run of letters,
 * digits, spaces or . _ - ' before the first colon) opens a new turn, and everything after that
 * first colon is the utterance — kept whole, so a colon inside the sentence survives. A line
 * with no such prefix is a continuation of the turn above it and is appended with its newline
 * intact, so wrapped text is reproduced character for character rather than dropped.
 */
export function parseTranscript(transcript: string): Turn[] {
  const turns: Turn[] = []

  for (const line of transcript.split('\n')) {
    const match = /^\s*([\p{L}\p{N}][\p{L}\p{N} ._'-]{0,23}):[ \t]?(.*)$/u.exec(line)

    // A digit on both sides of the colon is a clock time ("8:30 wali goli"), not a speaker
    // label — these transcripts are full of them, so a continuation line must not be split on one.
    const isClock = match !== null && /\d$/.test(match[1]) && /^\d/.test(match[2])

    if (match && !isClock) {
      const speaker = match[1].trim()
      turns.push({
        speaker,
        isAgent: speaker.toLowerCase() === AGENT_SPEAKER,
        text: match[2],
      })
      continue
    }

    if (turns.length > 0) {
      turns[turns.length - 1].text += `\n${line}`
      continue
    }

    // A transcript that opens without a speaker label: render it, unattributed, rather than
    // discard a line of what was said.
    if (line.trim() !== '') turns.push({ speaker: '', isAgent: false, text: line })
  }

  return turns
}

const safetyWord = (pass: boolean | null): string =>
  pass === true ? 'passed' : pass === false ? 'failed' : 'not recorded'

const SAFETY_MEANING: Record<'pass' | 'fail' | 'unknown', string> = {
  pass: 'The agent stayed inside its rules on this call — it did not diagnose, did not change a dose, and did not talk a worrying symptom down.',
  fail: 'Something on this call broke one of those rules. The call has been kept in full for review.',
  unknown:
    'No verdict was stored against this call. Read the transcript as the only record of it.',
}

const safetyMeaning = (pass: boolean | null) =>
  SAFETY_MEANING[pass === true ? 'pass' : pass === false ? 'fail' : 'unknown']

const STATUS_WORD: Record<string, string> = {
  completed: 'Call completed',
  no_answer: 'Nobody picked up',
  in_progress: 'Call in progress',
  failed: 'The call did not connect',
  cancelled: 'Call cancelled',
}

function spanMs(call: CallSession): number | null {
  if (!call.ended_at) return null
  const ms = new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()
  return ms > 0 ? ms : null
}

function spanWords(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest} s`
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function whenWords(at: Date, now: Date): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (at.toDateString() === now.toDateString()) return `Today ${time}`
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return `${at.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })} ${time}`
}

/** Back to the log — a router link, so it never reloads the app. */
function BackToCalls({ variant = 'quiet' }: { variant?: 'quiet' | 'button' }) {
  return (
    <Link
      to="/calls"
      className={clsx(
        variant === 'button'
          ? 'inline-flex items-center justify-center rounded-lg border border-ink px-4 py-2.5 text-base font-semibold'
          : 'text-sm underline',
      )}
    >
      All calls
    </Link>
  )
}

export default function CallDetail() {
  const { id } = useParams<{ id: string }>()
  const calls = useCalls()
  const doses = useDoseHistory()
  const observations = useObservations()
  const record = useCareRecord()

  if (calls.isLoading) return <LoadingBlock rows={6} />
  if (calls.error) return <ErrorBlock error={calls.error} onRetry={() => calls.refetch()} />

  const call = (calls.data ?? []).find((c) => c.id === id)

  // Unknown id — a dead link from an old share, or a call that was never stored. Say so and
  // give a way out; never a blank screen and never a crash.
  if (!call) {
    return (
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <Card emphasis="rule" className="gap-2">
          <Label>Call not found</Label>
          <div className="text-md font-semibold">
            There is no call in the record with that reference.
          </div>
          <p className="text-sm leading-relaxed break-words text-muted-strong">
            Nothing has been deleted — every call that happened is still in the log. The
            reference in this link{id ? ` (${id})` : ''} does not match any of them.
          </p>
          <Row>
            <BackToCalls variant="button" />
          </Row>
        </Card>
      </section>
    )
  }

  const now = new Date()
  const at = new Date(call.started_at)
  const ms = spanMs(call)
  const inbound = call.direction === 'in'
  const wasAnswered = call.status !== 'no_answer'

  const patient = record.data?.patient
  const who = patient ? `${patient.name}${patient.honorific ? `-${patient.honorific}` : ''}` : null
  const medications = record.data?.medications ?? []

  const callDoses = (doses.data ?? []).filter((d) => d.call_session_id === call.id)
  const callObservations = (observations.data ?? []).filter((o) => o.call_session_id === call.id)
  const turns = call.transcript === null ? [] : parseTranscript(call.transcript)

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Row className="gap-2">
        <BackToCalls />
      </Row>

      {/* -------------------------------------------------------------- header */}
      <Card emphasis={inbound ? 'border' : 'none'} className="gap-2">
        <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
          {inbound ? <Tag>they called</Tag> : <Tag outline>we called</Tag>}
          <Label className="ml-auto">{STATUS_WORD[call.status] ?? call.status.replace(/_/g, ' ')}</Label>
        </Row>

        <h1 className="text-lg leading-tight font-semibold break-words">
          {!wasAnswered
            ? `We called${who ? ` ${who}` : ''} — nobody picked up`
            : inbound
              ? `${who ?? 'They'} called us`
              : `We called${who ? ` ${who}` : ''}`}
        </h1>

        <Row className="flex-wrap gap-x-3 gap-y-1 text-base">
          <span>{whenWords(at, now)}</span>
          <span className="text-muted-strong">
            {!wasAnswered
              ? ms !== null
                ? `rang ${spanWords(ms)}, unanswered`
                : 'unanswered'
              : ms !== null
                ? `on the line ${spanWords(ms)}`
                : 'still on the line'}
          </span>
        </Row>

        <Divider />

        <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
          <Label>Safety check</Label>
          <span
            className={clsx('text-base font-semibold', call.safety_pass === false && 'underline')}
          >
            {safetyWord(call.safety_pass)}
          </span>
        </Row>
        <p className="text-sm leading-relaxed break-words text-muted-strong">
          {safetyMeaning(call.safety_pass)}
        </p>
      </Card>

      {/* ---------------------------------------------------------- transcript */}
      {call.transcript === null ? (
        <NoTranscript call={call} doses={callDoses} who={who} ms={ms} />
      ) : (
        <Card className="gap-2">
          <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
            <Label className="flex-1">Transcript</Label>
            <Label>
              {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
            </Label>
          </Row>
          <p className="text-sm leading-relaxed text-muted-strong">
            Stored exactly as it was said — Hindi and Hinglish as spoken, nothing translated,
            shortened or scored. The record keeps who said what, in order; it does not keep a
            time against each line, so none is shown.
          </p>

          {turns.length === 0 ? (
            <p className="text-base text-muted-strong">
              A transcript is stored for this call but it holds no readable lines.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {turns.map((turn, i) => (
                <TranscriptTurn key={i} turn={turn} who={who} />
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ----------------------------------------------- what this call produced */}
      <Card className="gap-2">
        <Label>What this call produced</Label>

        {doses.error || observations.error ? (
          <p className="text-sm text-muted-strong">
            What this call changed in the record could not be loaded just now. The transcript
            above is unchanged.
          </p>
        ) : callDoses.length === 0 && callObservations.length === 0 ? (
          <p className="text-base leading-relaxed break-words text-muted-strong">
            Nothing was written to the record on this call — no dose was logged and nothing was
            kept as an observation.
          </p>
        ) : (
          <>
            {callDoses.length > 0 && (
              <div className="flex flex-col gap-1">
                <Label>
                  {callDoses.length} dose {callDoses.length === 1 ? 'record' : 'records'}
                </Label>
                {callDoses.map((dose, i) => (
                  <div key={dose.id}>
                    {i > 0 && <Divider />}
                    <DoseLine
                      dose={dose}
                      medication={medications.find((m) => m.id === dose.medication_id)}
                    />
                  </div>
                ))}
              </div>
            )}

            {callDoses.length > 0 && callObservations.length > 0 && <Divider />}

            {callObservations.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>
                  {callObservations.length}{' '}
                  {callObservations.length === 1 ? 'observation' : 'observations'} kept
                </Label>
                {callObservations.map((observation) => (
                  <ObservationLine key={observation.id} observation={observation} />
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Row className="flex-wrap gap-x-3 gap-y-1">
        <BackToCalls />
        <Link to="/doses" className="text-sm underline">
          Dose history
        </Link>
        <Link to="/observations" className="text-sm underline">
          What she said
        </Link>
      </Row>
    </section>
  )
}

/**
 * One speaker turn.
 *
 * The agent and the person answering are told apart three ways at once — the speaker word is
 * always printed, the parent's lines carry a left rule and a filled tag, the agent's are
 * quieter and outlined — so nothing here depends on colour.
 */
function TranscriptTurn({ turn, who }: { turn: Turn; who: string | null }) {
  const parentLang = useParentLanguage()
  return (
    <div
      className={clsx(
        'flex flex-col gap-1 rounded-md py-1.5',
        turn.isAgent ? 'pl-0' : 'border-l-[3px] border-ink bg-paper px-2.5',
      )}
    >
      <Row className="flex-wrap gap-x-2 gap-y-1">
        {turn.speaker !== '' &&
          (turn.isAgent ? <Tag outline>{turn.speaker}</Tag> : <Tag>{turn.speaker}</Tag>)}
        <Label>
          {turn.isAgent
            ? 'the voice agent'
            : turn.speaker === ''
              ? 'speaker not recorded'
              : (who ?? 'on the call')}
        </Label>
      </Row>
      {/* Verbatim. No clamp, no truncation, no ellipsis — the full line always renders. */}
      <p
        lang={parentLang}
        className={clsx(
          'text-md leading-relaxed break-words hyphens-none whitespace-pre-wrap',
          turn.isAgent ? 'text-muted-strong' : 'font-semibold',
        )}
      >
        {turn.text}
      </p>
    </div>
  )
}

/**
 * The `no_answer` case. An empty transcript box would read as "we have nothing to show you";
 * what the caregiver needs is what was actually attempted, which the linked dose events record
 * in their own words ("Two retries, voicemail left").
 */
function NoTranscript({
  call,
  doses,
  who,
  ms,
}: {
  call: CallSession
  doses: DoseEvent[]
  who: string | null
  ms: number | null
}) {
  const tried = doses.filter((d) => d.note !== null)

  return (
    <Card emphasis="rule" className="gap-2">
      <Label>Transcript</Label>
      <div className="text-md font-semibold break-words">
        There is no transcript, because nobody picked up.
      </div>
      <p className="text-sm leading-relaxed break-words text-muted-strong">
        We rang {who ?? 'them'} at {clock(call.started_at)}
        {ms !== null ? ` and the line was open ${spanWords(ms)} — ringing, not talking` : ''}. No
        one answered, so nothing was said and there is nothing to store. This is not a call that
        went badly; it is a call that never happened.
      </p>

      {tried.length > 0 && (
        <>
          <Divider />
          <Label>What was tried</Label>
          {tried.map((dose) => (
            <p
              key={dose.id}
              className="border-l-2 border-line-strong pl-2 text-base leading-relaxed break-words whitespace-pre-line"
            >
              {dose.note}
            </p>
          ))}
        </>
      )}

      <Divider />
      <p className="text-sm leading-relaxed break-words text-muted-strong">
        Whether the dose was taken is not known either way. The safety check still applies to the
        attempt and reads {safetyWord(call.safety_pass)}.
      </p>
    </Card>
  )
}

/** One dose row this call wrote. Status in words, note verbatim, and a way into the history. */
function DoseLine({ dose, medication }: { dose: DoseEvent; medication: Medication | undefined }) {
  return (
    <Link to="/doses" className="-mx-1 block rounded px-1 py-1.5 hover:bg-line/40">
      <Row className="flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xs font-medium tracking-wide text-muted-strong">
          {clock(dose.slot_time)}
        </span>
        <span className="text-md font-semibold break-words">
          {medication?.name ?? 'Medicine'}
        </span>
        {medication && <span className="text-base text-muted-strong">{medication.dose}</span>}
        <span className="ml-auto shrink-0">
          <DoseStatusChip status={dose.status} />
        </span>
      </Row>
      {dose.note && (
        <p className="mt-1 border-l-2 border-line-strong pl-2 text-base leading-relaxed break-words whitespace-pre-line">
          {dose.note}
        </p>
      )}
    </Link>
  )
}

/** One observation this call kept — the sentence verbatim, exactly as the record holds it. */
function ObservationLine({ observation }: { observation: Observation }) {
  const parentLang = useParentLanguage()
  return (
    <Link to="/observations" className="-mx-1 block rounded px-1 py-1 hover:bg-line/40">
      <Row className="flex-wrap gap-x-2 gap-y-1">
        <SeverityChip severity={observation.severity} />
        <Label>{observation.kind}</Label>
        <Label className="ml-auto">{clock(observation.created_at)}</Label>
      </Row>
      <blockquote
        lang={parentLang}
        className={clsx(
          'mt-1 text-md leading-relaxed break-words hyphens-none whitespace-pre-wrap',
          observation.severity === 'red' ? 'font-semibold' : '',
        )}
      >
        “{observation.text}”
      </blockquote>
    </Link>
  )
}
