import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Button, Card, Chip, Divider, EmptyBlock, Label, Row, Tag } from '../../ui'
import { useSetupDraft } from '../../setup/store'
import type { DraftMedicine } from '../../setup/store'
import type { WithFood } from '../../api/types'

/**
 * 1e / 2d — Approve schedule.
 *
 * Phone: one stacked card per medicine. Desktop (sm and up): the same rows resolve into
 * the spreadsheet grid drawn in 2d, sharing one column template with the header strip.
 *
 * Two rules are enforced here rather than merely displayed:
 *  · FR-2 / TRD §3 — at most one medicine may carry is_priority.
 *  · FR-4          — no call is ever placed against an unsigned schedule, so the CTA is a
 *                    real <button disabled>, not a warning. Editing a row after signing
 *                    off clears the tick: the sign-off is on the list as it was read.
 */

const FOOD_LABEL: Record<WithFood, string> = {
  before: 'Before food',
  after: 'After food',
  any: 'Any time',
}

/** Shared by the header strip and every row so the columns actually line up. */
const GRID =
  'sm:grid sm:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_72px_minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-start sm:gap-3'

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export default function Schedule() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()
  const meds = draft.medicines
  const unclear = meds.filter((m) => m.unclear).length

  /** `${id}:${index}` of the slot chip currently open as a time editor. */
  const [editingSlot, setEditingSlot] = useState<string | null>(null)

  /** Every write goes through here: draft-persisted, and it re-opens the sign-off gate. */
  function commit(next: DraftMedicine[]) {
    patch({ medicines: next, scheduleConfirmed: false })
  }

  function update(id: string, changes: Partial<DraftMedicine>) {
    commit(meds.map((m) => (m.id === id ? { ...m, ...changes } : m)))
  }

  /** FR-2: priority is exclusive — switching one on switches every other one off. */
  function setPriority(id: string, on: boolean) {
    commit(
      meds.map((m) => {
        if (on) return { ...m, is_priority: m.id === id }
        return m.id === id ? { ...m, is_priority: false } : m
      }),
    )
  }

  function setSlot(id: string, index: number, time: string) {
    // <input type="time"> emits '' mid-edit; committing that makes an unschedulable row.
    if (!time) return
    const m = meds.find((x) => x.id === id)
    if (!m) return
    const slots = m.slots.map((s, i) => (i === index ? time : s))
    update(id, { slots })
  }

  function addSlot(id: string) {
    const m = meds.find((x) => x.id === id)
    if (!m) return
    update(id, { slots: [...m.slots, '08:00'] })
    setEditingSlot(`${id}:${m.slots.length}`)
  }

  function removeSlot(id: string, index: number) {
    const m = meds.find((x) => x.id === id)
    if (!m) return
    update(id, { slots: m.slots.filter((_, i) => i !== index) })
    setEditingSlot(null)
  }

  function addMedicine() {
    const row: DraftMedicine = {
      id: newId(),
      name: '',
      dose: '',
      slots: ['08:00'],
      with_food: 'any',
      is_priority: false,
    }
    commit([...meds, row])
  }

  /** A row that cannot generate a dose event must not be signable (FR-4 means what it says). */
  const incomplete = meds.filter(
    (m) =>
      !m.name.trim() ||
      !m.dose.trim() ||
      m.slots.length === 0 ||
      m.slots.some((t) => !/^\d{2}:\d{2}$/.test(t)),
  ).length
  const canSignOff = meds.length > 0 && unclear === 0 && incomplete === 0

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* top bar (1e) — back, title, calendar affordance */}
      <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={() => navigate('/setup/prescription')}
          aria-label="Back"
          className="-ml-1 grid size-11 place-items-center text-lg text-muted-strong"
        >
          ←
        </button>
        <h1 className="text-md font-bold">Review schedule</h1>
        <span className="ml-auto">
          <Chip>Calendar</Chip>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-3">
          {unclear > 0 && (
            <Card className="bg-paper">
              <Row className="flex-wrap">
                <Tag>check</Tag>
                <span className="flex-1 text-base text-muted-strong">
                  {unclear} {unclear === 1 ? 'row' : 'rows'} unclear — fix these before you sign off
                </span>
              </Row>
            </Card>
          )}

          {meds.length === 0 ? (
            <EmptyBlock
              title="No medicines yet"
              body="We build this schedule from the prescription. Add one and we read it for you."
              action={
                <Button variant="outline" onClick={() => navigate('/setup/prescription')}>
                  Add prescription
                </Button>
              }
            />
          ) : (
            <>
              {/* column strip — 2d's spreadsheet header, desktop only */}
              <div className={clsx('hidden px-3 sm:block', GRID)}>
                <Label>Medicine</Label>
                <Label>Dose · per dose</Label>
                <Label>Frequency</Label>
                <Label>Times</Label>
                <Label>Food rule</Label>
                <Label>Priority</Label>
              </div>

              {meds.map((m) => (
                <MedicineRow
                  key={m.id}
                  med={m}
                  editingSlot={editingSlot}
                  onEditSlot={setEditingSlot}
                  onChange={(changes) => update(m.id, changes)}
                  onSetSlot={(i, t) => setSlot(m.id, i, t)}
                  onAddSlot={() => addSlot(m.id)}
                  onRemoveSlot={(i) => removeSlot(m.id, i)}
                  onPriority={(on) => setPriority(m.id, on)}
                  onRemove={() => commit(meds.filter((x) => x.id !== m.id))}
                />
              ))}

              <Row className="flex-wrap">
                <Chip onClick={addMedicine}>+ Add medicine</Chip>
                <span className="text-xs text-muted">
                  Priority is the one dose the agent chases hardest — only one may hold it.
                </span>
              </Row>
            </>
          )}
        </div>
      </div>

      {/* pinned sign-off — FR-4 */}
      <footer className="border-t border-line bg-surface px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-4xl flex-col gap-2.5">
          <Card emphasis="rule">
            <div className="flex items-start gap-2.5">
              <input
                id="schedule-signoff"
                type="checkbox"
                checked={draft.scheduleConfirmed}
                disabled={!canSignOff}
                onChange={(e) => patch({ scheduleConfirmed: e.target.checked })}
                className="mt-0.5 size-4 shrink-0 accent-ink disabled:opacity-40"
              />
              <label htmlFor="schedule-signoff" className="flex-1 leading-snug">
                <span className="text-base font-semibold">
                  I confirm these {meds.length} {meds.length === 1 ? 'medicine' : 'medicines'}, doses and
                  timings are correct
                </span>
                <br />
                <span className="text-xs text-muted-strong">
                  Nothing is called about until you tick this.
                  {!canSignOff &&
                    (meds.length === 0
                      ? ' Add at least one medicine first.'
                      : unclear > 0
                        ? ' Resolve the unclear rows first.'
                        : ' Every medicine needs a name, a dose and at least one time.')}
                  {canSignOff && ' Editing a row after ticking clears the tick.'}
                </span>
              </label>
            </div>
          </Card>
          <Button
            disabled={!draft.scheduleConfirmed}
            onClick={() => navigate('/setup/consent')}
            className="w-full"
          >
            Continue to Consent
          </Button>
        </div>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------------- a row */

function MedicineRow({
  med,
  editingSlot,
  onEditSlot,
  onChange,
  onSetSlot,
  onAddSlot,
  onRemoveSlot,
  onPriority,
  onRemove,
}: {
  med: DraftMedicine
  editingSlot: string | null
  onEditSlot: (key: string | null) => void
  onChange: (changes: Partial<DraftMedicine>) => void
  onSetSlot: (index: number, time: string) => void
  onAddSlot: () => void
  onRemoveSlot: (index: number) => void
  onPriority: (on: boolean) => void
  onRemove: () => void
}) {
  const input =
    'w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-base text-ink placeholder:text-muted'

  return (
    <Card emphasis={med.unclear ? 'rule' : 'none'} className={clsx('gap-2.5', GRID)}>
      {/* name */}
      <div className="flex flex-col gap-1">
        <Row className="sm:hidden">
          <Label>Medicine</Label>
          {med.unclear && <Tag>unclear</Tag>}
        </Row>
        <input
          className={clsx(input, 'font-semibold')}
          value={med.name}
          placeholder="Medicine name"
          aria-label="Medicine name"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <div className="hidden sm:block">{med.unclear && <Tag>unclear</Tag>}</div>
      </div>

      {/* dose */}
      <div className="flex flex-col gap-1">
        <Label className="sm:hidden">Dose · per dose</Label>
        <input
          className={input}
          value={med.dose}
          placeholder="1 tab"
          aria-label="Dose per dose"
          onChange={(e) => onChange({ dose: e.target.value })}
        />
      </div>

      {/* frequency — derived, never typed */}
      <div className="flex flex-col gap-1">
        <Label className="sm:hidden">Frequency</Label>
        <div className="py-2 text-base whitespace-nowrap">{med.slots.length}× daily</div>
      </div>

      {/* times */}
      <div className="flex flex-col gap-1">
        <Label className="sm:hidden">Times</Label>
        <Row className="flex-wrap gap-1.5 py-1">
          {med.slots.map((slot, i) => {
            const key = `${med.id}:${i}`
            if (editingSlot === key) {
              return (
                <span key={key} className="inline-flex items-center gap-1">
                  <input
                    type="time"
                    autoFocus
                    value={slot}
                    aria-label={`Time ${i + 1} for ${med.name || 'this medicine'}`}
                    onChange={(e) => onSetSlot(i, e.target.value)}
                    onBlur={() => onEditSlot(null)}
                    onKeyDown={(e) => e.key === 'Enter' && onEditSlot(null)}
                    className="rounded-full border border-ink bg-paper px-2 py-0.5 text-sm"
                  />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onRemoveSlot(i)}
                    aria-label={`Remove time ${slot}`}
                    className="text-sm text-muted"
                  >
                    ✕
                  </button>
                </span>
              )
            }
            return (
              <Chip key={key} onClick={() => onEditSlot(key)}>
                {slot || '--:--'}
              </Chip>
            )
          })}
          <Chip onClick={onAddSlot}>+</Chip>
        </Row>
      </div>

      {/* food rule */}
      <div className="flex flex-col gap-1">
        <Label className="sm:hidden">Food rule</Label>
        <select
          className={input}
          value={med.with_food}
          aria-label="Food rule"
          onChange={(e) => onChange({ with_food: e.target.value as WithFood })}
        >
          {(Object.keys(FOOD_LABEL) as WithFood[]).map((k) => (
            <option key={k} value={k}>
              {FOOD_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      {/* priority · resolve · remove */}
      <div className="flex flex-col gap-1.5">
        <Divider className="sm:hidden" />
        <Row className="flex-wrap gap-2">
          <label className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              checked={med.is_priority}
              onChange={(e) => onPriority(e.target.checked)}
              className="size-5 accent-ink"
            />
            priority
          </label>
          {med.unclear && <Chip onClick={() => onChange({ unclear: false })}>✓ resolved</Chip>}
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${med.name || 'medicine'}`}
            className="ml-auto grid size-11 place-items-center text-md text-muted-strong"
          >
            ✕
          </button>
        </Row>
      </div>
    </Card>
  )
}
