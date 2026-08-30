import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AGENT_BASE } from '../../config'
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
 * call drives (`agent/src/core/call/lifecycle.js`). The caregiver's own number
 * is the caller, so the conversation opens in intake mode — the agent asks who
 * it is calling for and what they take, which is exactly the shape of the call
 * their parent will get.
 *
 * Skippable, always. Nothing downstream depends on what happens here, the agent
 * server may not even be running, and a caregiver on a train with no microphone
 * still has to reach the parent form.
 */

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
  inbound: 'Intake call',
  outbound: 'Reminder call',
  resume: 'Resuming where you left off',
}

type Language = 'hi' | 'en'

export default function Meet() {
  const navigate = useNavigate()
  const session = useSession()

  const [language, setLanguage] = useState<Language>('hi')
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
    if (voice.current || live) return

    setError(null)
    setOutcome(null)
    setMode(null)
    setTurns([])
    setState('connecting')

    const conversation = new VoiceSession({
      agentBase: AGENT_BASE,
      language,
      // The caregiver's own number: unknown to the agent's patient table, which
      // is what opens an intake conversation rather than a medication reminder
      // for someone else's parent.
      phone: session?.phone_e164 ?? '',
      direction: 'inbound',
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

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 text-lg font-bold sm:text-xl">Say hello to Asha</h1>
        <Label className="shrink-0">Optional</Label>
      </header>
      <p className="-mt-1 text-base text-muted-strong">
        This is the voice that will call your parent. Talk to her here first — she
        answers in {language === 'hi' ? 'Hindi' : 'English'}, the same as on a real call.
      </p>

      <Card className="items-center gap-4 py-6">
        <MicButton state={state} level={level} onStart={start} onStop={stop} />

        <div className="flex flex-col items-center gap-2">
          <StatusPill state={state} />
          {mode && <Label>{MODE_COPY[mode]}</Label>}
        </div>

        {/* The language choice is what she speaks, so it locks once she is
            speaking — swapping mid-sentence would restart the conversation. */}
        <div className="flex items-center gap-2">
          <LanguageToggle value={language} disabled={live} onChange={setLanguage} />
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

      <Card className="min-h-[220px] gap-3">
        {turns.length === 0 && !live && (
          <p className="m-auto max-w-xs text-center text-sm text-muted-strong">
            Press the button and allow your microphone. Asha speaks first — answer
            her the way your parent would.
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

      <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse sm:items-center">
        <Button
          className="sm:flex-1"
          onClick={() => {
            stop()
            navigate('/setup/parent')
          }}
        >
          {heard ? 'Set up my parent' : 'Continue'}
        </Button>
        {/* Skipping is a real path, not a dead end for the impatient: the agent
            server is a separate process and may simply not be up. */}
        {!heard && (
          <button
            type="button"
            onClick={() => {
              stop()
              navigate('/setup/parent')
            }}
            className="min-h-[44px] text-sm font-semibold text-muted-strong underline"
          >
            Skip for now
          </button>
        )}
      </div>
    </main>
  )
}

/**
 * The one control. It is a single button rather than a start/stop pair because
 * there is only ever one thing to do to a conversation: begin it, or end it.
 * The ring scales with mic level so a caregiver whose microphone is muted can
 * see that nothing is reaching us, rather than wondering why Asha is silent.
 */
function MicButton({
  state,
  level,
  onStart,
  onStop,
}: {
  state: VoiceState
  level: number
  onStart: () => void
  onStop: () => void
}) {
  const live = state !== 'idle'
  const connecting = state === 'connecting'

  return (
    <div className="relative grid size-[132px] place-items-center">
      {/* Purely decorative: it carries no information the status pill does not. */}
      <div
        aria-hidden
        className="absolute rounded-full bg-accent-soft transition-transform duration-100 ease-[var(--ease-out)]"
        style={{
          width: 132,
          height: 132,
          transform: `scale(${live ? 0.72 + Math.min(level, 1) * 0.28 : 0.72})`,
          opacity: live ? 1 : 0,
        }}
      />
      <button
        type="button"
        onClick={live ? onStop : onStart}
        disabled={connecting}
        aria-label={live ? 'End the conversation' : 'Start talking to Asha'}
        className={[
          'relative grid size-[96px] place-items-center rounded-full border-[1.5px] text-sm font-semibold',
          'transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out)]',
          !connecting && 'active:scale-[0.97]',
          live
            ? 'border-transparent bg-ink text-paper'
            : 'border-transparent bg-accent text-white hover:bg-accent-2',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {live ? 'End' : 'Talk'}
      </button>
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

function LanguageToggle({
  value,
  disabled,
  onChange,
}: {
  value: Language
  disabled?: boolean
  onChange: (next: Language) => void
}) {
  const options: { code: Language; label: string }[] = [
    { code: 'hi', label: 'हिन्दी Hindi' },
    { code: 'en', label: 'English' },
  ]
  return (
    <div className="flex gap-2">
      {options.map((option) => (
        <button
          key={option.code}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.code}
          onClick={() => onChange(option.code)}
          className={[
            'inline-flex min-h-[44px] items-center rounded-full border px-3.5 py-1 text-xs font-medium',
            value === option.code
              ? 'border-ink bg-ink text-paper'
              : 'border-line-strong bg-paper text-ink',
            disabled && value !== option.code && 'text-muted-strong',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** The two escalation outcomes are the ones a caregiver must not read as routine. */
function outcomeTone(label: string): 'ink' | 'danger' | 'warn' | 'accent' {
  if (label.startsWith('ESCALATED')) return 'danger'
  if (label === 'CONFIRMED') return 'accent'
  if (label === 'DENIED') return 'warn'
  return 'ink'
}
