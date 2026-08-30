import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Chip, Divider, Label, Row } from '../../ui'
import { missingParentFields, normalizePhoneInput, toE164, useSetupDraft } from '../../setup/store'

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

/** What each gated field is called on screen, so the CTA can name what is missing. */
const FIELD_LABELS: Record<string, string> = {
  parentName: 'name',
  age: 'age',
  relation: 'relation to you',
  parentPhone: 'a valid 10-digit phone',
  language: 'language',
}

const listed = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * Scroll to a gated field and put the caregiver in it.
 *
 * The footer named what was missing but left finding it as an exercise — and two
 * of the five are chip rows well above the fold on a phone, with a second,
 * different "relationship" question further down the same screen. Naming a field
 * you cannot then reach is how someone concludes the form is broken.
 *
 * Focus lands on the first control inside the group: the input for a text field,
 * the first chip for a chip row, so a keyboard user carries on from there.
 */
function goToField(key: string | undefined) {
  if (!key) return
  const group = document.querySelector<HTMLElement>(`[data-field="${key}"]`)
  if (!group) return
  group.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const control = group.querySelector<HTMLElement>('input, select, textarea, button')
  // After the scroll, not during: focusing first makes the browser jump to the
  // element and the smooth scroll then animates from the wrong place.
  window.setTimeout(() => control?.focus({ preventScroll: true }), 300)
}

export default function Parent() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()

  const missing = missingParentFields(draft)
  const ready = missing.length === 0
  const e164 = toE164(draft.parentPhone)

  // Naming them beats counting them. Two of the five are chips rather than text
  // fields — relation and language — and a caregiver who has filled in every box
  // they can see has no way to tell a bare count which one it means.
  const missingLabels = missing.map((k) => FIELD_LABELS[k] ?? k)

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate('/setup/meet')}
          className="-ml-1 grid size-11 place-items-center text-lg text-muted-strong"
        >
          &larr;
        </button>
        <h1 className="min-w-0 flex-1 text-lg font-bold sm:text-xl">Who are we caring for?</h1>
        <Label className="shrink-0">1 / 4</Label>
      </header>
      <p className="-mt-1 text-base text-muted-strong">
        Everything here shapes what the agent says on a call.
      </p>

      <Card className="gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          {/* data-field marks every gated control so the footer can take the
              caregiver to the one it is asking for. Naming a missing field is
              not much use on a form this long if finding it is their problem. */}
          <div data-field="parentName" className="sm:col-span-2">
            <FieldInput
              label="Name"
              value={draft.parentName}
              onChange={(v) => patch({ parentName: v })}
              placeholder="e.g. Sharma"
              required
            />
          </div>
          <FieldInput
            label="They are called"
            value={draft.honorific}
            onChange={(v) => patch({ honorific: v })}
            placeholder="e.g. ji"
          />
          <div data-field="age">
            <FieldInput
              label="Age"
              value={draft.age}
              onChange={(v) => patch({ age: v.replace(/\D/g, '').slice(0, 3) })}
              placeholder="e.g. 68"
              inputMode="numeric"
              required
            />
          </div>
        </div>

        <div data-field="relation" className="flex flex-col gap-1.5">
          {/* "Relation to you" and the escalation contact's "Relationship to your
              parent" are two different questions on one screen, and a caregiver
              who has just filled the second reasonably reads the footer as
              satisfied. Saying whose relation this is removes the collision. */}
          <Label>
            Your parent is your <Req />
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
          <div data-field="parentPhone">
            <FieldInput
              label="Parent&rsquo;s phone — the agent calls this"
              value={draft.parentPhone}
              onChange={(v) => patch({ parentPhone: normalizePhoneInput(v) })}
              placeholder="Their 10-digit mobile number"
              inputMode="tel"
              required
              hint={
                draft.parentPhone && !e164
                  ? 'Enter the 10-digit mobile number'
                  : e164
                    ? `Saved as ${e164}`
                    : undefined
              }
            />
          </div>
          <FieldInput
            label="Where they live"
            value={draft.address}
            onChange={(v) => patch({ address: v })}
            placeholder="e.g. 14 Rose Villa, Baner, Pune"
          />
        </div>
      </Card>

      {/* Wrapped rather than marked on the Card itself: Card destructures its
          props and drops anything it does not name, so a data-* on it never
          reaches the DOM. */}
      <div data-field="language">
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
          <p className="text-sm text-muted-strong">
            They can switch language mid-sentence; the agent follows.
          </p>
        </Card>
      </div>

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
          <p className="text-sm text-muted-strong">
            The agent will never name a medicine that conflicts with these.
          </p>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FieldInput
          label="Doctor's name"
          value={draft.doctorName}
          onChange={(v) => patch({ doctorName: v })}
          placeholder="e.g. Dr Rao"
          card
        />
        <FieldInput
          label="Doctor's phone"
          value={draft.doctorPhone}
          onChange={(v) => patch({ doctorPhone: normalizePhoneInput(v) })}
          placeholder="Their 10-digit phone number"
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
          className="w-full resize-none rounded-md border border-line-strong bg-paper px-2.5 py-2 text-base leading-relaxed outline-none placeholder:text-muted-strong focus:border-ink"
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
          <span className="flex-1 text-md font-semibold">Allow agent check-in calls</span>
          <span className="text-sm text-muted-strong">{draft.callsEnabled ? 'on' : 'off'}</span>
        </label>
        <p className="text-sm text-muted-strong">
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
            <span className="flex-1 text-base font-semibold">{c.name}</span>
            <span className="text-sm text-muted-strong">
              {c.relationship} · after {c.after}
            </span>
            <button
              type="button"
              aria-label={`Remove ${c.name}`}
              className="px-1 text-muted-strong"
              onClick={() => patch({ escalation: draft.escalation.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </Row>
        ))}
        <AddContact
          onAdd={(contact) => patch({ escalation: [...draft.escalation, contact] })}
        />
        <p className="text-sm text-muted-strong">Skip this — you can add people later.</p>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-col gap-2 bg-canvas px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-14px_18px_-14px_rgb(26_23_18/0.18)]">
        <Row>
          {ready ? (
            // Was "Name, age, relation, phone and language required" — a demand,
            // shown at the one moment nothing is being demanded. It read as an
            // unmet requirement beside an enabled button.
            <Label className="flex-1">Everything the agent needs is filled in</Label>
          ) : (
            <button
              type="button"
              onClick={() => goToField(missing[0])}
              className="min-w-0 flex-1 text-left underline decoration-dotted underline-offset-4"
            >
              <Label>Still needed: {listed(missingLabels)}</Label>
            </button>
          )}
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
/**
 * The chips here used to insert a hardcoded "Family member · sibling · after 15 min" row that
 * looked like captured data and could not be edited. A contact without a number cannot be
 * escalated to, so this asks for one.
 */
function AddContact({ onAdd }: { onAdd: (c: { name: string; relationship: string; after: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [relationship, setRelationship] = useState('')

  if (!open) return <Chip onClick={() => setOpen(true)}>+ add someone</Chip>

  const ready = name.trim().length > 1 && Boolean(toE164(phone))

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-strong bg-paper p-2.5">
      <div className="grid gap-2 sm:grid-cols-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          aria-label="Contact name"
          className="rounded-md border border-line-strong px-2.5 py-2 text-md outline-none focus:border-ink"
        />
        <input
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          placeholder="Sister, doctor, neighbour…"
          aria-label="Relationship to your parent"
          className="rounded-md border border-line-strong px-2.5 py-2 text-md outline-none focus:border-ink"
        />
        <input
          value={phone}
          inputMode="tel"
          onChange={(e) => setPhone(normalizePhoneInput(e.target.value))}
          placeholder="Their 10-digit mobile number"
          aria-label="Contact phone number"
          className="rounded-md border border-line-strong px-2.5 py-2 text-md outline-none focus:border-ink"
        />
      </div>
      <Row>
        <span className="flex-1 text-sm text-muted-strong">
          We only call someone we have a number for.
        </span>
        <Chip onClick={() => setOpen(false)}>Cancel</Chip>
        <Chip
          on={ready}
          onClick={() => {
            if (!ready) return
            onAdd({ name: name.trim(), relationship: relationship.trim() || 'contact', after: '15 min' })
            setName(''); setPhone(''); setRelationship(''); setOpen(false)
          }}
        >
          Add
        </Chip>
      </Row>
    </div>
  )
}

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
        className="w-32 rounded-full border border-ink bg-paper px-2.5 py-1 text-sm outline-none"
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
        className="w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-md outline-none placeholder:text-muted-strong focus:border-ink"
      />
      {hint && <span className="text-2xs text-muted-strong">{hint}</span>}
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
    <label className="flex items-center gap-2 text-sm text-muted-strong">
      {label}
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line-strong bg-paper px-2 py-1.5 text-base text-ink outline-none focus:border-ink"
      />
    </label>
  )
}
