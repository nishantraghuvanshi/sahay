import { useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Button, Card, Chip, Divider, Label, Row, Tag } from '../../ui'
import { toE164, useSetupDraft } from '../../setup/store'
import { ApiError, authApi } from '../../api/client'

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
  const { draft, patch, reset } = useSetupDraft()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Set the instant the write succeeds, so the FR-4 gate below stops applying.
   *  reset() empties the draft, which would otherwise make `scheduleConfirmed`
   *  false and bounce the caregiver back to the schedule they just signed off. */
  const [submitted, setSubmitted] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * The moment the draft stops being a draft.
   *
   * Until now everything the caregiver typed has lived in localStorage — three
   * minutes of it — and nothing had ever posted it. A failure here must leave
   * all of that intact and offer another go; wiping the draft on a network blip
   * would cost them the whole of onboarding.
   */
  const finish = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await authApi.post('/app/onboarding', {
        // Signup step 5 already set the caregiver's name, so this is sent empty
        // on purpose — the API COALESCEs it and leaves the stored name alone.
        // Sending '' here rather than dropping the field keeps the shape stable
        // for a future edit-profile screen that will want to change it.
        caregiver_name: '',
        relation: draft.relation,
        parent_name: draft.parentName,
        honorific: draft.honorific || null,
        parent_phone: toE164(draft.parentPhone) ?? draft.parentPhone,
        language: draft.language || 'hi-IN',
        age: draft.age ? Number(draft.age) : null,
        conditions: draft.conditions,
        allergies: draft.allergies,
        doctor_name: draft.doctorName || null,
        doctor_phone: draft.doctorPhone || null,
        address: draft.address || null,
        meal_times: draft.mealTimes,
        medicines: draft.medicines.map((m) => ({
          name: m.name,
          dose: m.dose,
          slots: m.slots,
          with_food: m.with_food,
          is_priority: m.is_priority,
        })),
        consents: draft.consents,
      })
      setSubmitted(true)
      reset()
      navigate('/home', { replace: true })
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  // FR-4: this screen must be unreachable without a signed-off schedule — including by
  // browser Forward or a typed URL, not only by the disabled button on 1e.
  if (!draft.scheduleConfirmed && !submitted) return <Navigate to="/setup/schedule" replace />

  const name = draft.parentName.trim() || 'your parent'
  const address = `${name}${draft.honorific ? `-${draft.honorific}` : ''}`

  const ticked = CONSENTS.filter((c) => draft.consents[c.id]).length
  const remaining = CONSENTS.length - ticked
  const scheduled = draft.introCall === 'later' ? draft.introCallAt : null
  const optionChosen = draft.introCall === 'now' || (draft.introCall === 'later' && Boolean(scheduled))
  const ready = optionChosen && remaining === 0

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate('/setup/schedule')}
          className="-ml-1 grid size-11 place-items-center text-lg text-muted-strong"
        >
          &larr;
        </button>
        <h1 className="min-w-0 flex-1 text-lg font-semibold sm:text-xl">Before we call {name}</h1>
        <Label className="shrink-0">4 / 4</Label>
      </header>

      <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr] lg:items-start">
        <div className="flex flex-col gap-3">
          <Card emphasis="none" className="gap-1.5">
            <div className="text-lg leading-snug font-medium">
              First we ring {address} once, just to introduce ourselves
            </div>
            <p className="text-base leading-relaxed text-muted-strong">
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
              <span className="flex-1 text-base leading-relaxed text-muted-strong">
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
                <span className="text-base leading-relaxed">{c.text(name)}</span>
              </label>
            ))}
            <Divider />
            <p className="text-sm text-muted-strong">
              All three are required. {address} can ask us to stop on any call, and we stop.
            </p>
          </Card>

          <Card className="gap-2">
            <Label>What happens next</Label>
            <StepLine done text={`We call ${name} — ${scheduled ? formatSlot(scheduled) : draft.introCall === 'now' ? 'in a minute or two' : 'once you pick a time'}`} />
            <StepLine text="They agree on that call" />
            <StepLine text="Dose calls begin from the next slot" />
          </Card>

          <p className="text-sm leading-relaxed text-muted-strong">
            All calling functionality begins only after this intro call and a final approval from
            {' '}{name}.
          </p>

          <div className="sticky bottom-0 z-10 flex flex-col gap-2 bg-canvas pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-14px_18px_-14px_rgb(26_23_18/0.18)]">
            <Button
              disabled={!ready || saving}
              onClick={() => void finish()}
              className="w-full"
            >
              {saving ? 'Saving…' : 'Continue on the app'}
            </Button>
            {saveError && (
              <p role="alert" aria-live="polite" className="text-center text-sm font-semibold">
                {saveError}
              </p>
            )}
            {!ready && (
              <span className="text-center text-sm text-muted-strong">
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
          <span className="block text-md font-semibold">{title}</span>
          <span className="block text-sm leading-relaxed text-muted-strong">{body}</span>
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
      <span className="flex-1 text-sm text-muted-strong">{text}</span>
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
        className="relative flex max-h-[80dvh] w-full max-w-md flex-col gap-3 overflow-auto rounded-t-2xl border border-line-strong bg-paper p-4 sm:rounded-2xl"
      >
        <div className="mx-auto h-1 w-8 rounded bg-line-strong sm:hidden" />
        <Row>
          <span className="flex-1 text-md font-semibold">When are they usually free?</span>
          <button type="button" aria-label="Close" onClick={onClose} className="px-1 text-muted-strong">
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
          <p className="text-base text-muted-strong">
            No slots left inside the call window today — try tomorrow.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
            <span className="text-sm text-muted-strong">
              {from} – {to}
            </span>
          </Row>
          <p className="text-2xs text-muted-strong">Times outside the window are not offered.</p>
        </Card>

        <Button disabled={!picked} onClick={() => picked && onPick(picked)} className="w-full">
          {picked ? `Set ${formatSlot(picked)}` : 'Pick a time'}
        </Button>
      </div>
    </div>
  )
}
