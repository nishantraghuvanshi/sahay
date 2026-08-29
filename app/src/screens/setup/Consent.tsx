import { useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Card, Chip, Divider, Label, Row, Tag } from '../../ui'
import { useSetupDraft } from '../../setup/store'
import { postOnboarding } from '../../api/hooks'
import { clearFiles } from '../../setup/files'

/**
 * Wireframe 1E.2 / 2D.2 — the last gate before anything dials.
 *
 * This screen carries three requirements at once:
 *   FR-4  no call is placed before explicit sign-off — enforced, not warned
 *   FR-5  the first call is a warm introduction, never a dose reminder
 *   SR-5  the parent is told the calls are coming and may stop them at any time
 *
 * The scheduling picker is a bottom sheet on a phone and an inline panel on desktop,
 * which is the only layout difference between 1E.2 and 2D.2.
 */

/** Copy is deliberately in one place — it is the wording most likely to change. */
const CONSENTS = [
  {
    id: 'informed',
    text: (name: string) =>
      `I have told ${name} that Kinvox will call, and they are happy to receive these calls.`,
  },
  {
    id: 'recording',
    text: () => 'I consent to these calls being recorded and transcribed so the record stays accurate.',
  },
  {
    id: 'no_advice',
    text: () =>
      'I understand Kinvox never gives medical advice — it captures what is said and tells me.',
  },
] as const

export default function Consent() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { draft, patch } = useSetupDraft()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // FR-4: this screen must be unreachable without a signed-off schedule — including by
  // browser Forward or a typed URL, not only by the disabled button on 1e.
  if (!draft.scheduleConfirmed) return <Navigate to="/setup/schedule" replace />

  const name = draft.parentName.trim() || 'your parent'
  const address = `${name}${draft.honorific ? `-${draft.honorific}` : ''}`

  const ticked = CONSENTS.filter((c) => draft.consents[c.id]).length
  const remaining = CONSENTS.length - ticked
  const scheduled = draft.introCall === 'later' ? draft.introCallAt : null
  const optionChosen = draft.introCall === 'now' || (draft.introCall === 'later' && Boolean(scheduled))
  const ready = optionChosen && remaining === 0

  /**
   * This is where the onboarding stops being a draft.
   *
   * Everything up to here lives in localStorage. The POST is what creates the
   * patient, writes the signed-off schedule with `confirmed_by`/`confirmed_at`,
   * and records the intro call — and until it succeeds nothing has been saved, so
   * a failure must keep the caregiver on this screen rather than dropping them on
   * a home screen showing somebody else's record.
   */
  async function finish() {
    setSaving(true)
    setSaveError(null)
    try {
      await postOnboarding(draft)
      // Saved. Release the prescription photographs — the schedule is the record
      // we keep, not the image it was read from.
      clearFiles()
      // The care record has changed underneath every screen that caches it.
      await queryClient.invalidateQueries()
      navigate('/home')
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Could not save the setup. Nothing has been lost.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate('/setup/schedule')}
          className="-ml-1 px-1 text-[16px] text-muted"
        >
          &larr;
        </button>
        <h1 className="text-[18px] font-bold">Before we call {name}</h1>
        <Label className="ml-auto">last step</Label>
      </header>

      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr] lg:items-start">
        <div className="flex flex-col gap-3">
          <Card emphasis="none" className="gap-1.5">
            <div className="text-[15px] leading-snug font-bold">
              First we ring {address} once, just to introduce ourselves
            </div>
            <p className="text-[12px] leading-relaxed text-muted-strong">
              No medicines on this call. We say who we are, that you set this up, and ask whether
              they are happy to be called. Dose calls begin only if they say yes.
            </p>
          </Card>

          <Label>When should that call happen?</Label>

          <Option
            selected={draft.introCall === 'now'}
            onSelect={() => patch({ introCall: 'now', introCallAt: null })}
            title={`Call ${name} now`}
            body="We dial in the next minute or two, from our number."
          />

          <Option
            selected={draft.introCall === 'later'}
            onSelect={() => {
              patch({ introCall: 'later' })
              setSheetOpen(true)
            }}
            title="Schedule the call for later"
            body="Pick a time they are usually free and near their phone."
          >
            <Row className="flex-wrap gap-2 pt-1">
              <Chip on={Boolean(scheduled)} onClick={() => setSheetOpen(true)}>
                {scheduled ? formatSlot(scheduled) : 'Pick a time'}
              </Chip>
              {scheduled && <Chip onClick={() => setSheetOpen(true)}>Change</Chip>}
            </Row>
          </Option>

          <Card className="gap-1.5">
            <Row>
              <Tag outline>note</Tag>
              <span className="flex-1 text-[12px] leading-relaxed text-muted-strong">
                We call {name} from our end — nothing dials from your phone.
              </span>
            </Row>
          </Card>
        </div>

        <div className="flex flex-col gap-3">
          <Card emphasis="rule" className="gap-2.5">
            <Row>
              <Label className="flex-1">Your consent</Label>
              {remaining > 0 ? <Label>{remaining} left</Label> : <Tag>complete</Tag>}
            </Row>
            {CONSENTS.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={Boolean(draft.consents[c.id])}
                  onChange={(e) =>
                    patch({ consents: { ...draft.consents, [c.id]: e.target.checked } })
                  }
                  className="mt-0.5 size-4 shrink-0 accent-[#1a1a1a]"
                />
                <span className="text-[12px] leading-relaxed">{c.text(name)}</span>
              </label>
            ))}
            <Divider />
            <p className="text-[11px] text-muted-strong">
              All three are required. {address} can ask us to stop on any call, and we stop.
            </p>
          </Card>

          <Card className="gap-2">
            <Label>What happens next</Label>
            <StepLine done text={`We call ${name} — ${scheduled ? formatSlot(scheduled) : draft.introCall === 'now' ? 'in a minute or two' : 'once you pick a time'}`} />
            <StepLine text="They agree on that call" />
            <StepLine text="Dose calls begin from the next slot" />
          </Card>

          <p className="text-[11px] leading-relaxed text-muted-strong">
            All calling functionality begins only after this intro call and a final approval from
            {' '}{name}.
          </p>

          <div className="sticky bottom-0 flex flex-col gap-2 bg-canvas pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {saveError && (
              <Card emphasis="rule">
                <Label>Not saved</Label>
                <span className="text-[11px] leading-relaxed text-muted-strong">
                  {saveError} Nothing has been sent and no call is scheduled. Try again.
                </span>
              </Card>
            )}
            <Button
              disabled={!ready || saving}
              onClick={() => void finish()}
              className="w-full"
            >
              {saving ? 'Saving…' : 'Continue on the app'}
            </Button>
            {!ready && (
              <span className="text-center text-[11px] text-muted">
                {!optionChosen
                  ? 'Choose when we should call first'
                  : `${remaining} consent${remaining === 1 ? '' : 's'} left`}
              </span>
            )}
          </div>
        </div>
      </div>

      {sheetOpen && (
        <TimeSheet
          from={draft.callWindowFrom}
          to={draft.callWindowTo}
          value={scheduled}
          onClose={() => setSheetOpen(false)}
          onPick={(iso) => {
            patch({ introCall: 'later', introCallAt: iso })
            setSheetOpen(false)
          }}
        />
      )}
    </main>
  )
}

function Option({
  selected,
  onSelect,
  title,
  body,
  children,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  body: string
  children?: React.ReactNode
}) {
  return (
    <Card emphasis={selected ? 'border' : 'none'}>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="radio"
          name="intro-call"
          checked={selected}
          onChange={onSelect}
          className="mt-0.5 size-4 shrink-0 accent-[#1a1a1a]"
        />
        <span className="flex-1">
          <span className="block text-[13px] font-semibold">{title}</span>
          <span className="block text-[11px] leading-relaxed text-muted-strong">{body}</span>
        </span>
      </label>
      {children}
    </Card>
  )
}

function StepLine({ text, done }: { text: string; done?: boolean }) {
  return (
    <Row className="items-start">
      <span
        className={clsx(
          'mt-1 inline-block size-2 shrink-0 rounded-full',
          done ? 'bg-ink' : 'border-[1.5px] border-line-strong bg-paper',
        )}
      />
      <span className="flex-1 text-[11px] text-muted-strong">{text}</span>
    </Row>
  )
}

/* ------------------------------------------------------------------ sheet */

/** Half-hourly slots inside the caregiver's stated call window, today and tomorrow. */
function slotsFor(day: 0 | 1, from: string, to: string): Date[] {
  const [fh, fm] = from.split(':').map(Number)
  const [th] = to.split(':').map(Number)
  const out: Date[] = []
  const base = new Date()
  base.setDate(base.getDate() + day)

  for (let h = fh; h <= th; h++) {
    for (const m of [0, 30]) {
      if (h === fh && m < fm) continue
      if (h === th && m > 0) continue
      const d = new Date(base)
      d.setHours(h, m, 0, 0)
      if (day === 0 && d.getTime() < Date.now() + 5 * 60_000) continue // no slot in the past
      out.push(d)
    }
  }
  return out
}

function formatSlot(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? 'Today' : d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function TimeSheet({
  from,
  to,
  value,
  onPick,
  onClose,
}: {
  from: string
  to: string
  value: string | null
  onPick: (iso: string) => void
  onClose: () => void
}) {
  const [day, setDay] = useState<0 | 1>(0)
  const slots = useMemo(() => slotsFor(day, from, to), [day, from, to])
  const [picked, setPicked] = useState<string | null>(value)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pick a time for the intro call"
        className="relative flex max-h-[80vh] w-full max-w-md flex-col gap-3 overflow-auto rounded-t-2xl border border-line-strong bg-paper p-4 sm:rounded-2xl"
      >
        <div className="mx-auto h-1 w-8 rounded bg-line-strong sm:hidden" />
        <Row>
          <span className="flex-1 text-[14px] font-bold">When are they usually free?</span>
          <button type="button" aria-label="Close" onClick={onClose} className="px-1 text-muted">
            ✕
          </button>
        </Row>

        <Label>Day</Label>
        <Row className="flex-wrap">
          <Chip on={day === 0} onClick={() => setDay(0)}>
            Today
          </Chip>
          <Chip on={day === 1} onClick={() => setDay(1)}>
            Tomorrow
          </Chip>
        </Row>

        <Label>Time</Label>
        {slots.length === 0 ? (
          <p className="text-[12px] text-muted-strong">
            No slots left inside the call window today — try tomorrow.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {slots.map((s) => {
              const iso = s.toISOString()
              return (
                <Chip key={iso} on={picked === iso} onClick={() => setPicked(iso)}>
                  {s.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </Chip>
              )
            })}
          </div>
        )}

        <Card className="gap-1">
          <Row>
            <Label className="flex-1">Their call window</Label>
            <span className="text-[11px] text-muted-strong">
              {from} – {to}
            </span>
          </Row>
          <p className="text-[10px] text-muted">Times outside the window are not offered.</p>
        </Card>

        <Button disabled={!picked} onClick={() => picked && onPick(picked)} className="w-full">
          {picked ? `Set ${formatSlot(picked)}` : 'Pick a time'}
        </Button>
      </div>
    </div>
  )
}
