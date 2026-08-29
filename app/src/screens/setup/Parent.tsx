import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Chip, Divider, Label, Row } from '../../ui'
import { missingParentFields, toE164, useSetupDraft } from '../../setup/store'

/**
 * Wireframe 1b / 2b — the parent profile. Everything captured here shapes what the agent
 * says on a call, which is why the language picker lives here and not on the login screen:
 * it is the language spoken *to the parent*, not the app's UI language.
 *
 * The CTA is disabled until the required fields are in (FR-1..FR-3), with a live count,
 * exactly as drawn. Escalation contacts are explicitly optional.
 */

const CONDITIONS = ['Hypertension', 'Type-2 diabetes', 'Thyroid', 'Arthritis', 'Heart disease']
const ALLERGIES = ['Sulfa drugs', 'Penicillin', 'Peanuts', 'Lactose']
const LANGUAGES = [
  { code: 'hi-IN', label: 'हिन्दी Hindi' },
  { code: 'en-IN', label: 'English' },
  { code: 'mr-IN', label: 'मराठी Marathi' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ Punjabi' },
]
const RELATIONS = ['Mother', 'Father', 'Grandmother', 'Grandfather', 'Other']

export default function Parent() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()

  const missing = missingParentFields(draft)
  const ready = missing.length === 0
  const e164 = toE164(draft.parentPhone)

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate('/login')}
          className="-ml-1 px-1 text-[16px] text-muted"
        >
          &larr;
        </button>
        <h1 className="text-[18px] font-bold">Who are we caring for?</h1>
        <Label className="ml-auto">1 / 3</Label>
      </header>
      <p className="-mt-1 text-[12px] text-muted-strong">
        Everything here shapes what the agent says on a call.
      </p>

      <Card className="gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FieldInput
            className="col-span-2"
            label="Name"
            value={draft.parentName}
            onChange={(v) => patch({ parentName: v })}
            placeholder="Sharma"
            required
          />
          <FieldInput
            label="They are called"
            value={draft.honorific}
            onChange={(v) => patch({ honorific: v })}
            placeholder="ji"
          />
          <FieldInput
            label="Age"
            value={draft.age}
            onChange={(v) => patch({ age: v.replace(/\D/g, '').slice(0, 3) })}
            placeholder="68"
            inputMode="numeric"
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>
            Relation to you <Req />
          </Label>
          <Row className="flex-wrap">
            {RELATIONS.map((r) => (
              <Chip key={r} on={draft.relation === r} onClick={() => patch({ relation: r })}>
                {r}
              </Chip>
            ))}
          </Row>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldInput
            label="Parent&rsquo;s phone — the agent calls this"
            value={draft.parentPhone}
            onChange={(v) => patch({ parentPhone: v })}
            placeholder="+91 98765 43210"
            inputMode="tel"
            required
            hint={
              draft.parentPhone && !e164
                ? '10 digits, or start with +country code'
                : e164
                  ? `Saved as ${e164}`
                  : undefined
            }
          />
          <FieldInput
            label="Where they live"
            value={draft.address}
            onChange={(v) => patch({ address: v })}
            placeholder="14 Rose Villa, Baner, Pune"
          />
        </div>
      </Card>

      <Card>
        <Label>
          Language the agent should speak <Req />
        </Label>
        <Row className="flex-wrap">
          {LANGUAGES.map((l) => (
            <Chip key={l.code} on={draft.language === l.code} onClick={() => patch({ language: l.code })}>
              {l.label}
            </Chip>
          ))}
        </Row>
        <p className="text-[11px] text-muted-strong">
          They can switch language mid-sentence; the agent follows.
        </p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <Label>Known conditions</Label>
          <Row className="flex-wrap">
            {CONDITIONS.map((c) => (
              <Chip
                key={c}
                on={draft.conditions.includes(c)}
                onClick={() => patch({ conditions: toggle(draft.conditions, c) })}
              >
                {c}
              </Chip>
            ))}
            {draft.conditions.filter((c) => !CONDITIONS.includes(c)).map((c) => (
              <Chip key={c} on onClick={() => patch({ conditions: toggle(draft.conditions, c) })}>
                {c} ✕
              </Chip>
            ))}
            <AddChip
              label="condition"
              onAdd={(v) => patch({ conditions: [...draft.conditions, v] })}
            />
          </Row>
        </Card>
        <Card>
          <Label>Allergies &amp; things to avoid</Label>
          <Row className="flex-wrap">
            {ALLERGIES.map((a) => (
              <Chip
                key={a}
                on={draft.allergies.includes(a)}
                onClick={() => patch({ allergies: toggle(draft.allergies, a) })}
              >
                {a}
              </Chip>
            ))}
            {draft.allergies.filter((a) => !ALLERGIES.includes(a)).map((a) => (
              <Chip key={a} on onClick={() => patch({ allergies: toggle(draft.allergies, a) })}>
                {a} ✕
              </Chip>
            ))}
            <AddChip label="allergy" onAdd={(v) => patch({ allergies: [...draft.allergies, v] })} />
          </Row>
          <p className="text-[11px] text-muted-strong">
            The agent will never name a medicine that conflicts with these.
          </p>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FieldInput
          label="Doctor's name"
          value={draft.doctorName}
          onChange={(v) => patch({ doctorName: v })}
          placeholder="Dr Rao"
          card
        />
        <FieldInput
          label="Doctor's phone"
          value={draft.doctorPhone}
          onChange={(v) => patch({ doctorPhone: v })}
          placeholder="+91 98450 12345"
          inputMode="tel"
          card
        />
      </div>

      <Card>
        <Label>Anything the agent should keep in mind</Label>
        <textarea
          aria-label="Anything the agent should keep in mind"
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          rows={3}
          placeholder='Hard of hearing on the left ear · gets confused after 9 PM · call them "Amma"'
          className="w-full resize-none rounded-md border border-line-strong bg-paper px-2.5 py-2 text-[12px] leading-relaxed outline-none placeholder:text-muted focus:border-ink"
        />
      </Card>

      <Card className="gap-3">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={draft.callsEnabled}
            onChange={(e) => patch({ callsEnabled: e.target.checked })}
            className="size-4 accent-[#1a1a1a]"
          />
          <span className="flex-1 text-[13px] font-semibold">Allow agent check-in calls</span>
          <span className="text-[11px] text-muted">{draft.callsEnabled ? 'on' : 'off'}</span>
        </label>
        <p className="text-[11px] text-muted-strong">
          Turn this off and we set everything up but place no calls. You can switch it on later.
        </p>
        <Divider />
        <Label>When may we call?</Label>
        <Row className="flex-wrap gap-3">
          <TimeInput
            label="From"
            value={draft.callWindowFrom}
            onChange={(v) => patch({ callWindowFrom: v })}
          />
          <TimeInput label="To" value={draft.callWindowTo} onChange={(v) => patch({ callWindowTo: v })} />
        </Row>
        <Divider />
        <Label>Meal times — so doses land sensibly</Label>
        <Row className="flex-wrap gap-3">
          <TimeInput
            label="Breakfast"
            value={draft.mealTimes.breakfast}
            onChange={(v) => patch({ mealTimes: { ...draft.mealTimes, breakfast: v } })}
          />
          <TimeInput
            label="Lunch"
            value={draft.mealTimes.lunch}
            onChange={(v) => patch({ mealTimes: { ...draft.mealTimes, lunch: v } })}
          />
          <TimeInput
            label="Dinner"
            value={draft.mealTimes.dinner}
            onChange={(v) => patch({ mealTimes: { ...draft.mealTimes, dinner: v } })}
          />
        </Row>
      </Card>

      <Card>
        <Row>
          <Label className="flex-1">Escalate to if I don&rsquo;t respond</Label>
          <Label>optional</Label>
        </Row>
        {draft.escalation.map((c, i) => (
          <Row key={i}>
            <span className="flex-1 text-[12px] font-semibold">{c.name}</span>
            <span className="text-[11px] text-muted">
              {c.relationship} · after {c.after}
            </span>
            <button
              type="button"
              aria-label={`Remove ${c.name}`}
              className="px-1 text-muted"
              onClick={() => patch({ escalation: draft.escalation.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </Row>
        ))}
        <Row className="flex-wrap">
          <Chip
            onClick={() =>
              patch({
                escalation: [
                  ...draft.escalation,
                  { name: 'Family member', relationship: 'sibling', after: '15 min' },
                ],
              })
            }
          >
            + family member
          </Chip>
          <Chip
            onClick={() =>
              patch({
                escalation: [
                  ...draft.escalation,
                  { name: draft.doctorName || 'Doctor', relationship: 'doctor', after: 'critical only' },
                ],
              })
            }
          >
            + doctor
          </Chip>
          <Chip
            onClick={() =>
              patch({
                escalation: [
                  ...draft.escalation,
                  { name: 'Neighbour', relationship: 'neighbour', after: 'no answer 3x' },
                ],
              })
            }
          >
            + neighbour
          </Chip>
        </Row>
        <p className="text-[11px] text-muted-strong">Skip this — you can add people later.</p>
      </Card>

      <div className="sticky bottom-0 mt-2 flex flex-col gap-2 bg-canvas pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Row>
          <Label className="flex-1">Name, age, relation, phone and language required</Label>
          {!ready && <Label>{missing.length} left</Label>}
        </Row>
        <Button disabled={!ready} onClick={() => navigate('/setup/prescription')}>
          Upload Prescription
        </Button>
      </div>
    </main>
  )
}

/**
 * The hard-coded chip lists cannot describe every parent. Anything typed here is
 * carried verbatim into the agent's context, so an unusual allergy is not silently lost.
 */
function AddChip({ label, onAdd }: { label: string; onAdd: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  const commit = () => {
    const v = value.trim()
    if (v) onAdd(v)
    setValue('')
    setOpen(false)
  }

  if (!open) return <Chip onClick={() => setOpen(true)}>+ add</Chip>

  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={value}
        aria-label={`Add a ${label}`}
        placeholder={`Add a ${label}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setOpen(false)
        }}
        onBlur={commit}
        className="w-32 rounded-full border border-ink bg-paper px-2.5 py-1 text-[11px] outline-none"
      />
    </span>
  )
}

function Req() {
  return <span className="text-ink">*</span>
}

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  required,
  hint,
  className,
  card,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: 'text' | 'tel' | 'numeric' | 'email'
  required?: boolean
  hint?: string
  className?: string
  card?: boolean
}) {
  const body = (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <Label>
        {label} {required && <Req />}
      </Label>
      <input
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-[13px] outline-none placeholder:text-muted focus:border-ink"
      />
      {hint && <span className="text-[10px] text-muted-strong">{hint}</span>}
    </div>
  )
  return card ? <Card>{body}</Card> : body
}

function TimeInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-muted-strong">
      {label}
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line-strong bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
      />
    </label>
  )
}
