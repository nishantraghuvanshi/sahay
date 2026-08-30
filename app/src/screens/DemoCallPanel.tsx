import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, Card, Chip, Divider, Label, Row, Tag } from '../ui'
import { getDemoCallStatus, postDemoCall } from '../api/hooks'
import type { DemoCall, DemoCallStatus, DemoTurn } from '../api/hooks'

/**
 * The optional demo call.
 *
 * A caregiver is about to let something phone their parent unsupervised. This
 * is the one place they can find out how it actually talks before that happens
 * — the real prompt, their parent's real name and medicine, and their real next
 * dose time, run against a scripted patient.
 *
 * Nobody's phone rings and nothing is written to the record. That is not a
 * limitation to hide: it is the reason this is safe to offer, so it is said on
 * the card rather than buried. The transcript is text because there is no audio
 * — simulate-conversation runs the model, not the voice — and a caregiver who
 * thinks they have heard the call would be misled about pacing and pauses.
 *
 * One per caregiver, enforced server-side.
 */

const PERSONAS: { key: string; label: string; hint: string }[] = [
  { key: 'forgot', label: 'Forgot the dose', hint: 'the ordinary case' },
  { key: 'took', label: 'Already taken it', hint: 'the happy path' },
  { key: 'refuses', label: 'Does not want to', hint: 'a refusal, and why' },
  { key: 'unwell', label: 'Feeling unwell', hint: 'raises an alert' },
]

/** Outcomes that mean a family alert would have fired on a real call. */
const ESCALATIONS = new Set(['ESCALATED_SYMPTOM', 'ESCALATED_DISTRESS'])

function Turn({ turn }: { turn: DemoTurn }) {
  if (turn.role === 'tool') {
    const outcome = typeof turn.args.outcome === 'string' ? turn.args.outcome : null
    return (
      <div className="flex items-center gap-2 py-1 pl-3">
        <Label className="shrink-0">did</Label>
        <span className="text-xs text-muted-strong">
          {turn.tool === 'report_outcome' && outcome
            ? `recorded the outcome as ${outcome}`
            : turn.tool === 'end_call'
              ? 'ended the call'
              : turn.tool}
        </span>
      </div>
    )
  }
  const isAgent = turn.role === 'agent'
  return (
    <div className={clsx('flex py-1', isAgent ? 'justify-start' : 'justify-end')}>
      <div
        className={clsx(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
          isAgent ? 'bg-fill text-ink' : 'border border-line-strong bg-paper text-ink',
        )}
      >
        <Label className="mb-0.5 block">{isAgent ? 'Asha' : 'your parent'}</Label>
        {turn.message}
      </div>
    </div>
  )
}

export default function DemoCallPanel() {
  const [status, setStatus] = useState<DemoCallStatus | null>(null)
  const [persona, setPersona] = useState('forgot')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DemoCall | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getDemoCallStatus()
      .then((s) => alive && setStatus(s))
      // A caregiver who is not signed in, or an API that is not there, simply
      // does not see the panel. It is optional; failing loudly here would be
      // noise on a screen that is about doses.
      .catch(() => alive && setStatus(null))
    return () => {
      alive = false
    }
  }, [])

  if (!status) return null

  async function run() {
    setRunning(true)
    setError(null)
    try {
      const res = await postDemoCall(persona)
      if (res.ok) {
        setResult(res)
        setStatus((s) => (s ? { ...s, available: false } : s))
      } else if (res.error === 'demo_already_used') {
        setStatus((s) => (s ? { ...s, available: false } : s))
        setError('You have already used your demo call.')
      } else if (res.error === 'onboarding_incomplete') {
        setError('Finish setting up the prescription first — a demo needs a name and a medicine to say.')
      } else {
        // The server hands the demo back when the failure was ours, so the
        // button stays live rather than telling them they have spent it.
        setError('The demo could not run just now. Your demo call has not been used.')
      }
    } catch {
      setError('The demo could not run just now. Your demo call has not been used.')
    } finally {
      setRunning(false)
    }
  }

  const escalated = result?.outcome && ESCALATIONS.has(result.outcome.label)

  return (
    <Card className="print:hidden">
      <Row>
        <h2 className="flex-1 text-base font-bold">Try a demo call</h2>
        <Label>optional</Label>
      </Row>

      <p className="text-xs leading-relaxed text-muted-strong">
        Hear how the reminder call goes before it ever reaches your parent. It uses
        their real medicine and dose times, but{' '}
        <strong className="font-semibold text-ink">nobody's phone rings</strong> and{' '}
        <strong className="font-semibold text-ink">nothing is recorded</strong> — a demo
        cannot mark a dose taken or alert anyone. You get one.
      </p>

      {!result && (
        <>
          <Divider />
          <Label>who is answering</Label>
          <Row className="flex-wrap gap-1.5">
            {PERSONAS.map((p) => (
              <Chip key={p.key} on={persona === p.key} onClick={() => setPersona(p.key)}>
                {p.label}
              </Chip>
            ))}
          </Row>
          <p className="text-xs text-muted-strong">
            {PERSONAS.find((p) => p.key === persona)?.hint}
          </p>
        </>
      )}

      {error && <p className="text-xs font-semibold text-danger">{error}</p>}

      {!result && (
        <Row>
          <Button
            onClick={run}
            disabled={running || !status.available || !status.ready}
            variant="outline"
          >
            {running ? 'Running the call…' : 'Run demo call'}
          </Button>
        </Row>
      )}

      {/* The reason a button is gated belongs beside it, in words. */}
      {!status.ready && (
        <p className="text-xs text-muted-strong">
          Available once the prescription is set up.
        </p>
      )}
      {status.ready && !status.available && !result && (
        <p className="text-xs text-muted-strong">
          You have already used your one demo call.
        </p>
      )}
      {running && (
        <p className="text-xs text-muted-strong">
          This takes up to a minute — the agent is holding a whole conversation.
        </p>
      )}

      {result && (
        <>
          <Divider />
          <Row>
            <Label className="flex-1">{result.persona_label}</Label>
            {result.outcome && (
              <Tag tone={escalated ? 'danger' : 'ink'}>{result.outcome.label}</Tag>
            )}
          </Row>

          <div className="flex flex-col">
            {result.turns.map((t, i) => (
              <Turn key={i} turn={t} />
            ))}
          </div>

          {result.outcome?.reason && (
            <p className="text-xs text-muted-strong">
              Recorded reason: “{result.outcome.reason}”
            </p>
          )}

          <Divider />
          <p className="text-xs leading-relaxed text-muted-strong">
            This was text, not speech — there is no audio, so it does not show how the
            call sounds or how long the pauses are. The actions above were simulated:
            nothing was written to {result.variables.parent_name}'s record, and no alert
            was sent.
          </p>
        </>
      )}
    </Card>
  )
}
