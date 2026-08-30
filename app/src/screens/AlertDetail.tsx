import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Bar,
  Button,
  Card,
  Divider,
  Dot,
  ErrorBlock,
  Label,
  LoadingBlock,
  Row,
  Tag,
  useParentLanguage,
} from '../ui'
import { useCalls, useCareRecord, useEscalations, useHandoff, useIntake } from '../api/hooks'
import { INTAKE_FIELD_COUNT } from '../api/types'
import type { CallSession, Escalation, IntakeFields, IntakeRecord, Patient } from '../api/types'

/**
 * Wireframe 1i (mobile) / 2g right pane (web) — FR-26, FR-27, FR-15.
 *
 * This is the screen a judge opens when they ask "how do you know it's a P1?". Three
 * things on it are load-bearing and none of them are decoration:
 *
 *   1. The literal rule string (`PR-3`). Not the letter, the sentence. It is what turns a
 *      judgement that looks subjective into one that can be audited.
 *   2. The 12-field intake record (`PRD §9.2`) with each field marked **from the record**
 *      or **asked on the call**. Six of twelve are inherited — that contrast *is* the
 *      product. A cold-start competitor asks all twelve, from a frightened caller, at 2 AM.
 *   3. The transcript, verbatim, with the line the rule matched highlighted. Hindi and
 *      Hinglish render exactly as stored: no transliteration, no translation, no summary.
 *
 * The action row follows rev 3 of the wireframe: the client removed `Copy handoff link`
 * from it and put three dial CTAs in its place. FR-27 still requires the copy action, so
 * it lives on the intake-record card instead (LANE-C-APP.md flags this exact conflict).
 *
 * 🔑 The app never dials. Every call action is a real `<a href="tel:">` — it opens the
 * handset's dialler with the number already typed, and the caregiver presses call.
 */

/* ------------------------------------------------------------------ handoff */

/**
 * TODO(Lane B): nothing exposes the handoff belonging to an intake record. The app needs
 * `GET /app/intake/{id}/handoff` → `{ token, created_at, expires_at, viewed_at }`, and this
 * constant goes away. Until then we read the one seeded handoff and only trust it if the
 * record it carries is the record on screen (checked below), so a wrong token can never
 * render someone else's link.
 */
const SEEDED_HANDOFF_TOKEN = 'demo-handoff-token-0001'

/* ------------------------------------------------------- the 12-field schema */

type Provenance = 'asked' | 'inherited' | 'confirmed' | 'computed'

interface FieldSpec {
  n: number
  key: keyof IntakeFields | 'priority'
  label: string
  provenance: Provenance
  /** Rendered as a quotation, in the language it was said in. */
  verbatim?: boolean
}

/** PRD §9.2, in the order the table lists them. Six of the twelve are never asked. */
const INTAKE_SCHEMA: FieldSpec[] = [
  { n: 1, key: 'caller_identity', label: 'Caller identity + relationship', provenance: 'asked' },
  { n: 2, key: 'patient_identity', label: 'Patient identity', provenance: 'inherited' },
  { n: 3, key: 'chief_complaint', label: 'Chief complaint', provenance: 'asked', verbatim: true },
  { n: 4, key: 'onset_time', label: 'Onset time', provenance: 'asked' },
  { n: 5, key: 'responsive', label: 'Responsive', provenance: 'asked' },
  { n: 6, key: 'breathing', label: 'Breathing', provenance: 'asked' },
  { n: 7, key: 'location', label: 'Location', provenance: 'confirmed' },
  { n: 8, key: 'current_medications', label: 'Current medicines', provenance: 'inherited' },
  { n: 9, key: 'known_allergies', label: 'Known allergies', provenance: 'inherited' },
  { n: 10, key: 'known_conditions', label: 'Known conditions', provenance: 'inherited' },
  { n: 11, key: 'callback_number', label: 'Callback number', provenance: 'inherited' },
  { n: 12, key: 'priority', label: 'Priority + cited rule', provenance: 'computed' },
]

const PROVENANCE_LABEL: Record<Provenance, string> = {
  asked: 'asked on the call',
  inherited: 'from the record',
  confirmed: 'from the record · confirmed',
  computed: 'computed by the rule',
}

/** Inherited and confirmed both mean "we already held it" — that is the six. */
const isInherited = (p: Provenance) => p === 'inherited' || p === 'confirmed'

const INHERITED_COUNT = INTAKE_SCHEMA.filter((f) => isInherited(f.provenance)).length
const ASKED_COUNT = INTAKE_SCHEMA.filter((f) => f.provenance === 'asked').length

function valueFor(spec: FieldSpec, record: IntakeRecord): string | null {
  if (spec.key === 'priority') {
    const parts = [record.priority, record.priority_rule].filter(Boolean)
    return parts.length ? parts.join(' · ') : null
  }
  const raw = record.fields[spec.key]
  return raw && raw.trim() ? raw : null
}

/* ------------------------------------------------------------------ formatting */

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function dayLabel(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** '2 min 11 s' — read off started_at/ended_at, never estimated. */
function callDuration(call: CallSession | null): string | null {
  if (!call?.ended_at) return null
  const seconds = Math.max(
    0,
    Math.round((new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) / 1000),
  )
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`
}

const spokenName = (patient: Patient) =>
  patient.honorific ? `${patient.name}-${patient.honorific}` : patient.name

/* ------------------------------------------------------------------ transcript */

interface TranscriptLine {
  speaker: string
  text: string
  agent: boolean
}

/** Stored as `speaker: line` per row. A line that does not parse is kept, not dropped. */
function parseTranscript(transcript: string | null): TranscriptLine[] {
  if (!transcript) return []
  return transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([A-Za-z][\w .-]{0,24}):\s*(.*)$/.exec(line)
      if (!match) return { speaker: '', text: line, agent: false }
      const speaker = match[1].trim().toLowerCase()
      return { speaker, text: match[2], agent: speaker === 'agent' }
    })
}

/** Punctuation- and case-insensitive, so "chest bhaari lagti hai." matches the stored field. */
const normalise = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * The line the rule matched. We only claim a match when the stored chief complaint is
 * actually present in a line the parent spoke — a guessed highlight on this screen would
 * be worse than none.
 */
function triggerLineIndex(lines: TranscriptLine[], chiefComplaint: string | null): number {
  if (!chiefComplaint) return -1
  const needle = normalise(chiefComplaint)
  if (needle.length < 4) return -1
  return lines.findIndex((line) => !line.agent && normalise(line.text).includes(needle))
}

const EXCERPT_LINES = 7

/** A window around the matched line, so the excerpt always contains the reason it exists. */
function excerpt(lines: TranscriptLine[], trigger: number): { lines: TranscriptLine[]; from: number } {
  if (lines.length <= EXCERPT_LINES) return { lines, from: 0 }
  const anchor = trigger >= 0 ? trigger : lines.length - 1
  const from = Math.max(0, Math.min(anchor - 3, lines.length - EXCERPT_LINES))
  return { lines: lines.slice(from, from + EXCERPT_LINES), from }
}

/* ------------------------------------------------------------------- screen */

export default function AlertDetail() {
  const parentLang = useParentLanguage()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const escalations = useEscalations()
  const record = useCareRecord()
  const calls = useCalls()

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [resolvedAt, setResolvedAt] = useState<Date | null>(null)

  const escalation = escalations.data?.find((e) => e.id === id) ?? null
  const intake = useIntake(escalation?.intake_record_id ?? undefined)
  const handoff = useHandoff(SEEDED_HANDOFF_TOKEN)

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = setTimeout(() => setCopyState('idle'), 3000)
    return () => clearTimeout(timer)
  }, [copyState])

  const back = () => navigate('/alerts')

  if (escalations.isLoading || record.isLoading) return <LoadingBlock rows={6} />

  if (escalations.error || record.error) {
    return (
      <NotLoaded
        error={escalations.error ?? record.error}
        onRetry={() => {
          void escalations.refetch()
          void record.refetch()
        }}
        onBack={back}
      />
    )
  }

  if (!escalation) {
    return (
      <NotLoaded
        error={new Error('We could not find that alert.')}
        onBack={back}
        hint="It may have been opened from an old link. The alerts list has everything that has fired."
      />
    )
  }

  const patient = record.data!.patient
  const caregiver = record.data!.caregiver
  const name = spokenName(patient)

  const now = new Date()
  const firedAt = escalation.sent_at ? new Date(escalation.sent_at) : null
  const levelTone: 'danger' | 'warn' | 'ink' =
    escalation.level === 'P1' ? 'danger' : escalation.level === 'P2' ? 'warn' : 'ink'

  const intakeRecord = intake.data ?? null
  const chiefComplaint = intakeRecord?.fields.chief_complaint?.trim() || null

  const allCalls = [...(calls.data ?? [])].sort((a, b) => a.started_at.localeCompare(b.started_at))
  const callIndex = intakeRecord
    ? allCalls.findIndex((c) => c.id === intakeRecord.call_session_id)
    : -1
  const call = callIndex >= 0 ? allCalls[callIndex] : null
  const duration = callDuration(call)

  const lines = parseTranscript(call?.transcript ?? null)
  const trigger = triggerLineIndex(lines, chiefComplaint)
  const shown = excerpt(lines, trigger)

  // Every escalation raised off this same intake record — who was told, who is still pending.
  const deliveries: Escalation[] = escalation.intake_record_id
    ? (escalations.data ?? []).filter((e) => e.intake_record_id === escalation.intake_record_id)
    : [escalation]

  /**
   * Only trust the seeded token if the handoff it returns is for the record on screen.
   * Wrong record → no copy button, rather than a link to somebody else's intake.
   */
  const handoffMatches = Boolean(
    intakeRecord && handoff.data && handoff.data.intake.id === intakeRecord.id,
  )
  const handoffLink = handoffMatches ? `${window.location.origin}/h/${SEEDED_HANDOFF_TOKEN}` : null
  const viewedAt = handoffMatches && handoff.data?.viewed_at ? new Date(handoff.data.viewed_at) : null

  async function copyHandoffLink(link: string) {
    try {
      // Undefined on http:// and inside some in-app browsers — never let that throw.
      if (!navigator.clipboard?.writeText) {
        setCopyState('failed')
        return
      }
      await navigator.clipboard.writeText(link)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  /**
   * The escalation ladder's next contact has no phone column in TRD §3 (raised in
   * docs/SCHEMA-GAPS-LANE-C.md). The one number we can stand behind is the caregiver's own,
   * and only when the alert names them. Anything else renders disabled — we do not invent
   * a number for a dial button.
   */
  const escalateTo = escalation.sent_to || caregiver.name
  const escalateNumber = escalation.sent_to === caregiver.name ? caregiver.phone_e164 : null

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
      {/* -------------------------------------------------------------- header */}
      <Row className="flex-wrap gap-x-3">
        <Link to="/alerts" className="text-sm underline">
          ‹ All alerts
        </Link>
        <Link to="/observations" className="ml-auto text-sm underline">
          What she said ›
        </Link>
      </Row>

      <Card emphasis="border" className="gap-2.5">
        <Row className="flex-wrap gap-2">
          <Tag tone={levelTone}>{escalation.level}</Tag>
          <Label className="flex-1">Alert detail</Label>
          {resolvedAt && <Tag tone="accent" outline>resolved</Tag>}
        </Row>

        <h1
          lang={parentLang}
          className="text-xl leading-snug font-medium break-words hyphens-none sm:text-2xl"
        >
          {chiefComplaint ? `“${chiefComplaint}”` : `${escalation.level} alert raised`}
        </h1>

        <div className="text-sm leading-relaxed text-muted-strong">
          {firedAt ? `${dayLabel(firedAt, now)} · ${clock(firedAt)}` : 'Not yet sent'}
          {call && ` · agent call #${callIndex + 1}`}
          {duration && ` · ${duration}`}
        </div>

        {call && (
          <Row>
            <Link to={`/calls/${call.id}`} className="text-sm underline">
              Open the whole call
            </Link>
          </Row>
        )}
      </Card>

      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[1.5fr_1fr] lg:items-start lg:gap-4">
        {/* ------------------------------------------- left: rule, transcript, record */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* 🔑 the cited rule, rendered literally (PR-3) */}
          <Card emphasis={escalation.level === 'P1' ? 'danger' : 'rule'} className="gap-2">
            <Row>
              <Label className="flex-1">Why this was flagged</Label>
              <Tag tone={levelTone}>{escalation.level}</Tag>
            </Row>
            <div className="text-sm leading-relaxed font-semibold break-words sm:text-md">
              {escalation.reason}
            </div>
            {intakeRecord?.priority_rule && intakeRecord.priority_rule !== escalation.reason && (
              <div className="text-base leading-relaxed break-words">
                {intakeRecord.priority_rule}
                <span className="text-muted-strong"> · stored on the intake record</span>
              </div>
            )}
            <Divider />
            <div className="text-sm leading-relaxed text-muted-strong">
              Triggered on the words {name} used. No interpretation, no diagnosis.
            </div>
            <div className="text-sm leading-relaxed text-muted-strong">
              That sentence is a stored rule, written before the call and matched exactly as it
              reads. It is not the agent's opinion and it names no condition.
            </div>
          </Card>

          {/* ------------------------------------------------------- transcript */}
          <Card className="gap-2.5">
            <Row className="flex-wrap gap-2">
              <Label className="flex-1">Transcript excerpt</Label>
              {call && <Label>{dayLabel(new Date(call.started_at), now)} {clock(new Date(call.started_at))}</Label>}
            </Row>

            {intake.isLoading && <LoadingBlock rows={4} />}

            {!intake.isLoading && lines.length === 0 && (
              <div className="text-base text-muted-strong">
                No transcript was stored for this call. The alert still stands on the rule above.
              </div>
            )}

            {shown.lines.map((line, i) => {
              const absolute = shown.from + i
              const matched = absolute === trigger
              return (
                <div key={`${absolute}:${line.speaker}`} className="flex flex-col gap-1">
                  <Row className="items-start gap-2">
                    <span className="shrink-0 pt-0.5">
                      <Tag outline={line.agent}>{line.speaker || 'note'}</Tag>
                    </span>
                    {/* Verbatim. Rendered in the language it was spoken in — never translated. */}
                    <span
                      lang={parentLang}
                      className={clsx(
                        'min-w-0 flex-1 rounded text-base leading-relaxed break-words hyphens-none whitespace-pre-wrap',
                        line.agent && !matched && 'text-muted-strong',
                        matched && 'rounded bg-highlight px-1.5 py-0.5 font-semibold',
                      )}
                    >
                      {line.text}
                    </span>
                  </Row>
                  {matched && (
                    <Row className="gap-1.5 pl-1">
                      <Dot kind="filled" tone="accent" />
                      <span className="text-xs font-semibold text-accent">
                        this line is what the rule matched
                      </span>
                    </Row>
                  )}
                </div>
              )
            })}

            {lines.length > shown.lines.length && call && (
              <Link to={`/calls/${call.id}`} className="text-sm underline">
                Full transcript ›
              </Link>
            )}

            {lines.length > 0 && (
              <div className="text-xs leading-relaxed text-muted-strong">
                Stored word for word, in the language it was spoken. Nothing here is translated or
                shortened.
              </div>
            )}
          </Card>

          {/* ----------------------------------------- the intake record (§9.2) */}
          <Card className="gap-2.5">
            <Row className="flex-wrap gap-2">
              <Label className="flex-1">The intake record</Label>
              {intakeRecord && (
                <Label>
                  {Math.round(intakeRecord.completeness * INTAKE_FIELD_COUNT)}/{INTAKE_FIELD_COUNT}{' '}
                  captured
                </Label>
              )}
            </Row>

            {intake.isLoading && <LoadingBlock rows={4} />}
            {intake.error && <ErrorBlock error={intake.error} onRetry={() => void intake.refetch()} />}
            {!intake.isLoading && !intake.error && !intakeRecord && (
              <div className="text-base text-muted-strong">
                This alert was raised without an intake record.
              </div>
            )}

            {intakeRecord && (
              <>
                <Bar fill={intakeRecord.completeness} />
                <div className="text-sm leading-relaxed text-muted-strong">
                  {INHERITED_COUNT} of the {INTAKE_FIELD_COUNT} fields came straight from{' '}
                  {name}'s record — the agent never had to ask for them. {ASKED_COUNT} were asked
                  on the call, and the last one is computed by the rule engine. Anyone starting
                  cold has to ask all {INTAKE_FIELD_COUNT}, of a frightened caller.
                </div>

                <Divider />

                <div className="flex flex-col">
                  {INTAKE_SCHEMA.map((spec) => (
                    <IntakeFieldRow key={spec.n} spec={spec} value={valueFor(spec, intakeRecord)} />
                  ))}
                </div>

                <Divider />

                {/* ------------------------------------------- FR-27 copy handoff link */}
                <Label>Share this record</Label>
                {handoffLink ? (
                  <>
                    <div className="text-sm leading-relaxed text-muted-strong">
                      A read-only copy of all {INTAKE_FIELD_COUNT} fields. It opens on any phone
                      with no login and nothing to install.
                    </div>
                    <div className="rounded-md border border-line-strong bg-paper px-2.5 py-2 text-sm break-all select-all">
                      {handoffLink}
                    </div>
                    <Row className="flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void copyHandoffLink(handoffLink)}>
                        {copyState === 'copied' ? 'Copied ✓' : 'Copy link'}
                      </Button>
                      <span className="text-sm text-muted-strong">
                        {viewedAt
                          ? `Opened ${dayLabel(viewedAt, now)} ${clock(viewedAt)}`
                          : 'Not opened yet'}
                      </span>
                    </Row>
                    {copyState === 'failed' && (
                      <div className="text-sm font-semibold">
                        This browser would not let us copy. Select the link above and copy it by
                        hand — it is the same link.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm leading-relaxed text-muted-strong">
                    No share link has been created for this record yet.
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        {/* ------------------------------------------ right: actions and delivery */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* Rev 3 of 1i: primary dial full width, two dial CTAs paired, then resolve. */}
          <Card className="gap-2">
            <Label>Do something now</Label>

            <Button href={`tel:${patient.phone_e164}`} disabled={!patient.phone_e164}>
              Call {name} now
            </Button>

            <Row className="flex-col items-stretch gap-2 sm:flex-row">
              <Button
                variant="outline"
                className="min-w-0 flex-1"
                href={patient.doctor_phone ? `tel:${patient.doctor_phone}` : undefined}
                disabled={!patient.doctor_phone}
              >
                Call {patient.doctor_name ?? 'the doctor'} now
              </Button>
              <Button
                variant="outline"
                className="min-w-0 flex-1"
                href={escalateNumber ? `tel:${escalateNumber}` : undefined}
                disabled={!escalateNumber}
              >
                Escalate to {escalateTo}
              </Button>
            </Row>

            {!escalateNumber && (
              <div className="text-xs text-muted-strong">
                No number on file for {escalateTo} yet.
              </div>
            )}

            {resolvedAt ? (
              <Row className="gap-2">
                <Dot kind="filled" />
                <span className="flex-1 text-base font-semibold">
                  Marked resolved · {clock(resolvedAt)}
                </span>
              </Row>
            ) : (
              <Button variant="outline" onClick={() => setResolvedAt(new Date())}>
                Mark resolved
              </Button>
            )}

            <Divider />
            <div className="text-xs leading-relaxed text-muted-strong">
              These three open your phone's dialler with the number already in it. You press the
              green button — nothing dials on its own.
            </div>
          </Card>

          {/* ------------------------------------------------------- delivery */}
          <Card className="gap-2">
            <Label>Told to</Label>
            {deliveries.map((d) => {
              const sent = d.sent_at ? new Date(d.sent_at) : null
              const status = d.delivery_status ?? (sent ? 'sent' : 'pending')
              const kind = status === 'delivered' || status === 'read' ? 'filled' : status === 'failed' ? 'hollow' : 'empty'
              const tone = status === 'delivered' || status === 'read' ? 'accent' : status === 'failed' ? 'danger' : 'ink'
              return (
                <div key={d.id} className="flex flex-col gap-0.5">
                  <Row className="items-start gap-2">
                    <span className="pt-1">
                      <Dot kind={kind} tone={tone} />
                    </span>
                    <span className="min-w-0 flex-1 text-base break-words">
                      {d.sent_to} · {d.channel}
                    </span>
                    <Label className="shrink-0 text-right">
                      {sent ? clock(sent) : 'pending'}
                    </Label>
                  </Row>
                  <div className="pl-4 text-xs text-muted-strong">
                    {status}
                    {sent && ` · ${dayLabel(sent, now)}`}
                  </div>
                </div>
              )
            })}
          </Card>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- pieces */

/** One of the twelve. A field we do not hold reads "not captured", never blank. */
function IntakeFieldRow({ spec, value }: { spec: FieldSpec; value: string | null }) {
  const parentLang = useParentLanguage()
  const inherited = isInherited(spec.provenance)
  return (
    <div className="flex flex-col gap-1 border-b border-line py-2 last:border-b-0">
      <Row className="items-start gap-2">
        <span className="w-4 shrink-0 text-2xs font-medium text-muted-strong tabular-nums">{spec.n}</span>
        <span className="min-w-0 flex-1 text-sm font-semibold">{spec.label}</span>
        <span className="shrink-0">
          {/* Filled = the agent had to ask. Outlined = we already held it. */}
          <Tag outline={inherited || spec.provenance === 'computed'}>
            {PROVENANCE_LABEL[spec.provenance]}
          </Tag>
        </span>
      </Row>
      <div className="pl-6">
        {value ? (
          <span
            lang={spec.verbatim ? parentLang : undefined}
            className={clsx(
              'block text-base leading-relaxed break-words hyphens-none',
              spec.verbatim && 'font-semibold',
            )}
          >
            {spec.verbatim ? `“${value}”` : value}
          </span>
        ) : (
          <span className="block text-base text-muted-strong italic">not captured</span>
        )}
      </div>
    </div>
  )
}

/** Never a blank screen and never a dead end — there is always a way back to the list. */
function NotLoaded({
  error,
  onRetry,
  onBack,
  hint,
}: {
  error: unknown
  onRetry?: () => void
  onBack: () => void
  hint?: string
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <ErrorBlock error={error} onRetry={onRetry} />
      {hint && <div className="px-1 text-sm text-muted-strong">{hint}</div>}
      <Row>
        <Button variant="outline" onClick={onBack}>
          Back to all alerts
        </Button>
      </Row>
    </div>
  )
}
