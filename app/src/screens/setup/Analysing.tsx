import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Button, Card, Chip, Dot, Label, Placeholder, Row, Tag } from '../../ui'
import { useSetupDraft } from '../../setup/store'
import type { DraftMedicine } from '../../setup/store'

/**
 * Wireframe 1d (mobile) / 2c right column (web) — OCR running on the uploaded pages.
 *
 * Nothing is actually read here: the screen plays out the four stages on timers and then
 * writes the fixture's three medicines into the draft. It exists because a four-second
 * silent wait reads as a hang — naming each stage is what makes the wait tolerable, and it
 * sets the expectation that the caregiver, not the OCR, has the final say on the schedule.
 */

const STAGES = [
  { label: 'Enhancing & deskewing image', ms: 420 },
  { label: 'Extracting text (OCR)', ms: 720 },
  { label: 'Matching 3 medicines to drug database', ms: 780 },
  { label: 'Building dose schedule', ms: 480 },
] as const

/** Cumulative finish time per stage — also what each completed row prints. */
const ELAPSED = STAGES.reduce<number[]>((acc, s, i) => [...acc, (acc[i - 1] ?? 0) + s.ms], [])

/**
 * Must stay identical to scripts/mock-api.json → medications, so the schedule screen (1e)
 * and the mock API agree about what was on the prescription. Atorvastatin is flagged
 * unclear on purpose: 1e needs one row to highlight for review.
 */
const DETECTED: DraftMedicine[] = [
  {
    id: 'm1000000-0000-4000-8000-000000000001',
    name: 'Metformin',
    dose: '500mg',
    slots: ['08:30', '21:00'],
    with_food: 'after',
    is_priority: true,
  },
  {
    id: 'm1000000-0000-4000-8000-000000000002',
    name: 'Amlodipine',
    dose: '5mg',
    slots: ['08:30'],
    with_food: 'any',
    is_priority: false,
  },
  {
    id: 'm1000000-0000-4000-8000-000000000003',
    name: 'Atorvastatin',
    dose: '10mg',
    slots: ['21:00'],
    with_food: 'after',
    is_priority: false,
    unclear: true,
  },
]

const UNCLEAR_COUNT = DETECTED.filter((m) => m.unclear).length

export default function Analysing() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()

  /** Number of finished stages: index < done is complete, === done is running. */
  const [done, setDone] = useState(0)
  const allDone = done >= STAGES.length

  useEffect(() => {
    // One timeout per stage rather than a chain, so unmount clears every pending one and
    // no setState lands after the caregiver has navigated away.
    const timers = ELAPSED.map((at, i) => window.setTimeout(() => setDone(i + 1), at))
    return () => timers.forEach(window.clearTimeout)
  }, [])

  useEffect(() => {
    if (!allDone) return
    // Write the detection ONCE. Coming back to this screen (Schedule's back button, or the
    // browser's) must never overwrite medicines the caregiver has since edited — and if it
    // ever did write, the sign-off would be sitting on a list they never saw (FR-4).
    if (draft.ocrDone) return
    patch({ medicines: DETECTED, ocrDone: true, scheduleConfirmed: false })
  }, [allDone, draft.ocrDone, patch])

  /**
   * Names surface as the stages clear — nothing before OCR has run, everything once the
   * database match is in. Monotone by construction, so a chip never disappears.
   */
  const revealed = Math.max(0, Math.min(DETECTED.length, done - 1))

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-3 p-3 sm:p-5">
      <Row>
        <h1 className="flex-1 text-[15px] font-bold">Reading prescription…</h1>
        <Label>step 3 / 4</Label>
      </Row>

      {/* Web 2c puts the page preview beside the stage log; a phone stacks them. */}
      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        <div className="flex flex-col gap-2">
          <Placeholder className="h-[150px] flex-col gap-1 lg:h-[210px]">
            <span>scanned page preview</span>
            <span className="text-[9.5px]">(detected dose lines boxed)</span>
          </Placeholder>
          <div className="text-[10px] text-muted">
            {draft.files.length > 0
              ? `Reading ${draft.files.length} file${draft.files.length > 1 ? 's' : ''} · ${draft.files
                  .map((f) => f.name)
                  .join(' · ')}`
              : 'Reading the uploaded pages.'}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* aria-live sits on a wrapper: Card only forwards className and children. */}
          <div aria-live="polite">
            <Card className="gap-2.5">
              {STAGES.map((stage, i) => {
                const complete = i < done
                const running = i === done
                return (
                  <Row key={stage.label}>
                    <Dot kind={complete ? 'filled' : running ? 'hollow' : 'empty'} />
                    <span
                      className={clsx(
                        'flex-1 text-[12px]',
                        running && 'font-semibold',
                        !complete && !running && 'text-muted',
                      )}
                    >
                      {stage.label}
                    </span>
                    <Label>
                      {complete ? `${(ELAPSED[i] / 1000).toFixed(1)}s` : running ? '…' : ''}
                    </Label>
                  </Row>
                )
              })}
            </Card>
          </div>

          <Card>
            <Label>Found so far</Label>
            <Row className="flex-wrap gap-1.5">
              {revealed === 0 && <span className="text-[11px] text-muted">still reading…</span>}
              {DETECTED.slice(0, revealed).map((m) => (
                <Chip key={m.id}>
                  {m.name} {m.dose}
                  {m.unclear ? ' ?' : ''}
                </Chip>
              ))}
            </Row>
            {allDone && (
              <Row>
                <Tag>{UNCLEAR_COUNT} unclear</Tag>
                <span className="flex-1 text-[11px] text-muted-strong">
                  You'll confirm these next.
                </span>
              </Row>
            )}
          </Card>
        </div>
      </div>

      {allDone && draft.allergies.length > 0 && (
        <Card emphasis="rule">
          <Row>
            <Tag outline>check</Tag>
            <span className="flex-1 text-[11px] leading-relaxed text-muted-strong">
              {draft.allergies.join(', ')} on file — nothing in this prescription conflicts.
            </span>
          </Row>
        </Card>
      )}

      <Button className="w-full" disabled={!allDone} onClick={() => navigate('/setup/schedule')}>
        Continue
      </Button>
      <p className="text-[10px] text-muted">
        Enabled once matching finishes. Nothing is saved to the care record until you sign the
        schedule off.
      </p>
    </section>
  )
}
