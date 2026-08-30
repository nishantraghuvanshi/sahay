import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AGENT_BASE, AGENT_KEY } from '../../config'
import { useSession } from '../../auth/SessionProvider'
import { Button, Card, Label, Tag } from '../../ui'
import {
  VoiceSession,
  type VoiceMode,
  type VoiceOutcome,
  type VoiceState,
  type VoiceTurn,
} from '../../lib/voiceSession'

/**
 * The step between signing up and describing a parent: meet the agent.
 *
 * Everything after this screen is a form about someone who is not in the room —
 * a parent's name, their medicines, a schedule, a consent checkbox. Handing a
 * caregiver four screens of intake before they have heard a single word the
 * agent says asks them to trust a voice they have never heard with their
 * mother's medication. So they hear it first, in the browser, for free.
 *
 * It is the real agent, not a demo reel: the same `/playground` WebSocket the
 * agent server's own page uses, which drives the same session lifecycle a phone
 * call drives (`agent/src/core/call/lifecycle.js`), reads the same prompt YAML,
 * and speaks through the same TTS. What the left rail configures is the dose —
 * medicine, before or after which meal — and those go into the very same
 * `{drug_name}` and `{dose_timing}` slots a real reminder call fills.
 *
 * Skippable, always. Nothing downstream depends on what happens here, the agent
 * server may not even be running, and a caregiver on a train with no microphone
 * still has to reach the parent form.
 */

/**
 * The medicines on offer. A fixed list, not a text field: the caregiver has not
 * told us about a parent yet, so there is nothing to draw from, and a free-text
 * box would invite a name the pharmacy database has never heard of two screens
 * before we ask for the real prescription. Common Indian maintenance drugs, the
 * kind an adherence call is actually about.
 */
const MEDICINES = [
  'Crocin',
  'Metformin',
  'Amlodipine',
  'Thyronorm',
  'Atorvastatin',
  'Telmisartan',
  'Pantoprazole',
  'Ecosprin',
]

/** Matches `WithFood` in api/types.ts, minus 'any' — there is no meal to name. */
const RELATIONS: { value: MealRelation; label: string }[] = [
  { value: 'before', label: 'Before meal' },
  { value: 'after', label: 'After meal' },
]

const MEALS: { value: Meal; label: string }[] = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
]

/** Copy for each state of the socket, in the caregiver's terms, not the protocol's. */
const STATE_COPY: Record<VoiceState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
}

/** What the resolved mode means, for the badge under the status. */
const MODE_COPY: Record<VoiceMode, string> = {
  outbound: 'Reminder call',
  inbound: 'Intake call',
  resume: 'Resuming where you left off',
}

type MealRelation = 'before' | 'after'
type Meal = 'breakfast' | 'lunch' | 'dinner'
type Language = 'hi' | 'en'

export default function Meet() {
  const navigate = useNavigate()
  const session = useSession()

  // --- left rail: what call to simulate -------------------------------------
  const [medicine, setMedicine] = useState('')
  const [relation, setRelation] = useState<MealRelation | null>(null)
  const [meal, setMeal] = useState<Meal | null>(null)
  /**
   * Hindi, and only Hindi. The agent refuses to load the English prompt at all
   * — `medication-adherence-en.yaml` trails the Hindi one by a dozen versions
   * and the strategy throws rather than serve stale guardrails — so an English
   * option here was a button that could only produce an error.
   */
  const language: Language = 'hi'

  // --- right pane: the conversation -----------------------------------------
  const [state, setState] = useState<VoiceState>('idle')
  const [mode, setMode] = useState<VoiceMode | null>(null)
  const [turns, setTurns] = useState<VoiceTurn[]>([])
  const [outcome, setOutcome] = useState<VoiceOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState(false)

  /** The live session. A ref, not state: nothing renders off the object itself. */
  const voice = useRef<VoiceSession | null>(null)
  const transcriptEnd = useRef<HTMLDivElement | null>(null)

  const live = state !== 'idle'
  const phone = session?.phone_e164 ?? ''
  const configured = Boolean(medicine && relation && meal)
  const canStart = configured && Boolean(phone) && !live

  /**
   * One partial at a time. The server sends a growing partial for the current
   * utterance and then a final; appending each would print the sentence a word
   * at a time down the page, so a partial replaces a partial and a final
   * replaces the partial it completes.
   */
  const pushTurn = useCallback((turn: VoiceTurn) => {
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'user' && last.partial) return [...prev.slice(0, -1), turn]
      return [...prev, turn]
    })
    if (!turn.partial) setHeard(true)
  }, [])

  /** Follow the conversation without stealing the page's own scroll position. */
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [turns, outcome])

  /**
   * A live microphone must not survive this screen. Navigating on with the
   * agent mid-sentence is the ordinary case, not the edge case.
   */
  useEffect(() => () => voice.current?.stop(), [])

  const start = async () => {
    if (voice.current || !canStart || !relation || !meal) return

    setError(null)
    setOutcome(null)
    setMode(null)
    setTurns([])
    setState('connecting')

    const conversation = new VoiceSession({
      agentBase: AGENT_BASE,
      apiKey: AGENT_KEY,
      language,
      // The caregiver's own number stands in for the parent's, so the agent has
      // a record to open a session against. `direction: outbound` is what makes
      // this the reminder call the left rail describes — the same mode, prompt
      // and opening line a real dose call uses.
      phone,
      direction: 'outbound',
      drugName: medicine,
      mealRelation: relation,
      meal,
      onState: setState,
      onMode: setMode,
      onTurn: pushTurn,
      onOutcome: setOutcome,
      onError: setError,
      onLevel: setLevel,
      onClosed: () => {
        voice.current = null
        setLevel(0)
      },
    })

    voice.current = conversation
    await conversation.start()
  }

  const stop = () => {
    voice.current?.stop()
    voice.current = null
  }

  const leave = () => {
    stop()
    navigate('/setup/parent')
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-bold sm:text-xl">Say hello to Asha</h1>
        <Label className="shrink-0">Optional</Label>
      </header>
      <p className="-mt-1 text-base text-muted-strong">
        This is the voice that will call your parent. Set up a dose, then talk to
        her — she speaks Hindi, the same as on a real call.
      </p>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* ---------------------------------------------------------- left rail */}
        {/* Locked once the call is under way. A medicine swapped mid-sentence
            would not reach the agent — the prompt is composed once, at open —
            so a control that still looked live would be lying about what the
            voice is saying. */}
        <Card className="gap-4 lg:sticky lg:top-4">
          <div className="flex items-center justify-between gap-2">
            <Label>The call</Label>
            {live && <Tag outline>Locked</Tag>}
          </div>

          <Group label="Medicine">
            <select
              value={medicine}
              disabled={live}
              onChange={(e) => setMedicine(e.target.value)}
              aria-label="Medicine"
              className="min-h-[44px] w-full rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-sm text-ink disabled:text-muted-strong"
            >
              <option value="">Choose a medicine</option>
              {MEDICINES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Group>

          <Group label="When to take it">
            <Options
              options={RELATIONS}
              value={relation}
              disabled={live}
              onChange={setRelation}
            />
          </Group>

          <Group label="Which meal">
            <Options options={MEALS} value={meal} disabled={live} onChange={setMeal} />
          </Group>

          <Group label="Language">
            <p className="text-sm text-muted-strong">
              हिन्दी — the only language the agent is cleared to speak today.
            </p>
          </Group>

          <div className="flex flex-col gap-2 border-t border-line-strong pt-3">
            <Button
              variant={live ? 'outline' : 'accent'}
              disabled={!live && !canStart}
              onClick={live ? stop : start}
            >
              {live ? 'End the call' : 'Start the call'}
            </Button>
            {/* Why the button is gated, beside the button, in plain words. */}
            {!live && !configured && (
              <p className="text-sm text-muted-strong">
                Pick a medicine, when it is taken, and which meal.
              </p>
            )}
            {!live && configured && !phone && (
              <p className="text-sm text-muted-strong">
                Your phone number is still loading — one moment.
              </p>
            )}
            {!live && canStart && (
              <p className="text-sm text-muted-strong">
                Asha will call about {medicine}, {relation === 'before' ? 'before' : 'after'}{' '}
                {meal}. Allow your microphone when asked.
              </p>
            )}
          </div>
        </Card>

        {/* --------------------------------------------------------- right pane */}
        <div className="flex flex-col gap-3">
          <Card className="items-center gap-4 py-6">
            <MicRing state={state} level={level} />
            <div className="flex flex-col items-center gap-2">
              <StatusPill state={state} />
              {mode && <Label>{MODE_COPY[mode]}</Label>}
            </div>
          </Card>

          {error && (
            <Card emphasis="danger">
              <p className="text-sm font-semibold">{error}</p>
              <p className="text-sm text-muted-strong">
                You can skip this and come back to it later — nothing here is saved.
              </p>
            </Card>
          )}

          <Card className="min-h-[260px] gap-3">
            {turns.length === 0 && !live && (
              <p className="m-auto max-w-xs text-center text-sm text-muted-strong">
                Asha speaks first, the moment the call starts. Answer her the way
                your parent would.
              </p>
            )}

            {turns.map((turn, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Label>{turn.role === 'agent' ? 'Asha' : 'You'}</Label>
                <p className={turn.partial ? 'text-base text-muted-strong italic' : 'text-base'}>
                  {turn.text}
                </p>
              </div>
            ))}

            {outcome && (
              <div className="flex items-center gap-2 border-t border-line-strong pt-3">
                <Tag outline tone={outcomeTone(outcome.label)}>
                  {outcome.label.replace(/_/g, ' ')}
                </Tag>
                {outcome.reason && <p className="text-sm text-muted-strong">{outcome.reason}</p>}
              </div>
            )}

            <div ref={transcriptEnd} />
          </Card>
        </div>
      </div>

      {/* One button, not two. Both went to the same place and ran the same
          `stop()` — a separate "Skip for now" link only asked the caregiver to
          choose between two identical outcomes. The label carries the permission
          instead: skipping is a real path, because the agent server is a separate
          process and may simply not be up. */}
      <div className="pt-1">
        <Button className="w-full" onClick={leave}>
          {heard ? 'Set up my parent' : 'Continue, skip for now'}
        </Button>
      </div>
    </main>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

/**
 * A row of single-choice chips. Disabled is `Warm Inert`, same as Button: the
 * chosen option stays legible on a warm ground rather than fading to a ghost,
 * because while the call runs this row is the only record of what was picked.
 */
function Options<T extends string>({
  options,
  value,
  disabled,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T | null
  disabled?: boolean
  onChange: (next: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const on = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(option.value)}
            className={[
              'inline-flex min-h-[44px] items-center rounded-full border px-3.5 py-1 text-xs font-medium',
              'transition-[background-color,border-color,color] duration-150 ease-[var(--ease-out)]',
              on ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-paper text-ink',
              !on && !disabled && 'hover:border-ink',
              !on && disabled && 'text-muted-strong',
              !disabled && 'active:scale-[0.97]',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The mic level, as a ring. It carries no information the status pill does not
 * except one: that sound is actually reaching us. A caregiver whose microphone
 * is muted at the OS level sees a still ring and knows, instead of wondering
 * why Asha has gone quiet.
 */
function MicRing({ state, level }: { state: VoiceState; level: number }) {
  const live = state !== 'idle'
  return (
    <div className="relative grid size-[132px] place-items-center">
      <div
        aria-hidden
        className="absolute size-[132px] rounded-full bg-accent-soft transition-transform duration-100 ease-[var(--ease-out)]"
        style={{
          transform: `scale(${live ? 0.72 + Math.min(level, 1) * 0.28 : 0.72})`,
          opacity: live ? 1 : 0,
        }}
      />
      <div
        className={[
          'relative grid size-[96px] place-items-center rounded-full text-sm font-semibold',
          live ? 'bg-ink text-paper' : 'border-[1.5px] border-line-strong bg-paper text-muted-strong',
        ].join(' ')}
      >
        {live ? 'On call' : 'Ready'}
      </div>
    </div>
  )
}

/** Status is a word plus a shape, never colour alone (ui/index.tsx house rule). */
function StatusPill({ state }: { state: VoiceState }) {
  const active = state === 'listening' || state === 'speaking' || state === 'thinking'
  return (
    <span className="inline-flex min-h-[34px] items-center gap-2 rounded-full border border-line-strong bg-paper px-3.5 py-1 text-xs font-medium">
      <span
        aria-hidden
        className={[
          'size-2 rounded-full',
          state === 'listening' && 'bg-accent',
          state === 'speaking' && 'bg-ink',
          state === 'thinking' && 'bg-warn',
          !active && 'border border-muted-strong',
        ]
          .filter(Boolean)
          .join(' ')}
      />
      {STATE_COPY[state]}
    </span>
  )
}

/** The two escalation outcomes are the ones a caregiver must not read as routine. */
function outcomeTone(label: string): 'ink' | 'danger' | 'warn' | 'accent' {
  if (label.startsWith('ESCALATED')) return 'danger'
  if (label === 'CONFIRMED') return 'accent'
  if (label === 'DENIED') return 'warn'
  return 'ink'
}
