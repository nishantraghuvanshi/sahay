import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  Bar,
  Button,
  Card,
  Chip,
  Divider,
  EmptyBlock,
  ErrorBlock,
  Label,
  LoadingBlock,
  Placeholder,
  Row,
  Tag,
} from '../ui'
import { useCareRecord } from '../api/hooks'
import type { Medication, WithFood } from '../api/types'

/**
 * 1G.2 / 2F.2 — `/medicines/edit`, "Change medicines".
 *
 * The sibling of `setup/Schedule.tsx`, and deliberately built from the same parts: inline slot
 * chips that open a `<input type="time">`, the one-priority rule enforced in the same commit,
 * a real `<button disabled>` behind a real checkbox. Two things are different, and both matter:
 *
 *  1. This screen edits the **live record** (`useCareRecord()`), not the onboarding draft. Nothing
 *     here touches `useSetupDraft` — a caregiver changing Mom's evening dose in month three must
 *     not reopen, or be blocked by, a signup draft in localStorage. Edits live in component state
 *     until they are committed.
 *  2. Stopping is not deleting. `medications` is what the agent calls about *and* what a judge
 *     cross-checks; a stopped row stays visible, struck through and restorable, so the caregiver
 *     can see what they took away (2F.2 draws exactly this — Atorvastatin, greyed, `stopped`, ↺).
 *
 * The gate is the point of the screen. The consent text is stored verbatim and rendered verbatim,
 * because `docs/SCHEMA-GAPS-LANE-C.md` §3 wants it persisted as text, not as a boolean: a consent
 * you cannot reproduce is not evidence. Any further edit clears the tick — same reasoning as the
 * onboarding sign-off, the consent is on the diff *as it was read*.
 *
 * No end-date column, on purpose: `medications` has no such field (schema gap §4), and
 * `CareRecord.tsx` already refuses to render one. The 2F.2 column stays unbuilt until the column
 * exists.
 */

/** The gate. Rendered verbatim and posted verbatim (SCHEMA-GAPS §3 `consent_text`). */
const CONSENT_TEXT =
  'Hey, I am fully aware of the changes that I am making in this calendar, and these changes have been explicitly advised by our doctor.'

const FOOD_LABEL: Record<WithFood, string> = {
  before: 'Before food',
  after: 'After food',
  any: 'Any time',
}

/** Shared by the header strip and every row so the columns actually line up (2F.2 grid). */
const GRID =
  'sm:grid sm:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_72px_minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-start sm:gap-3'

const newId = () => `new-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Screen-local editing shape. `Medication` has no `stopped` column, so stopping is expressed
 *  here and posted as a diff — the record is never mutated in place by the browser. */
interface EditRow {
  id: string
  name: string
  dose: string
  slots: string[]
  with_food: WithFood
  is_priority: boolean
  /** Marked "stop this" in this editing session. Stays on screen until saved. */
  stopped: boolean
  /** Added on this screen, so it has no baseline row and is removed rather than stopped. */
  isNew: boolean
}

interface UploadFile {
  id: string
  name: string
  size: number
  /** 0–100, the same number the caption prints. */
  progress: number
}

interface Change {
  key: string
  text: string
}

function toRow(m: Medication): EditRow {
  return {
    id: m.id,
    name: m.name,
    dose: m.dose,
    slots: [...m.slots],
    // `with_food` is nullable in the schema; 'any' is the editing default, and the diff
    // compares against the same normalisation so a null never reads as a change.
    with_food: m.with_food ?? 'any',
    is_priority: m.is_priority,
    stopped: false,
    isNew: false,
  }
}

/* ------------------------------------------------------------------ the diff */

/**
 * Times are diffed as a set, then paired up: one time out and one time in on the same medicine
 * reads as a move ("21:00 → 21:30 Metformin"), which is what actually happened and what 2F.2
 * draws. Leftovers on either side are reported as added or dropped.
 */
function diffSlots(id: string, before: string[], after: string[], label: string): Change[] {
  const removed = before.filter((t) => !after.includes(t))
  const added = after.filter((t) => !before.includes(t))
  const moved = Math.min(removed.length, added.length)
  const out: Change[] = []
  for (let i = 0; i < moved; i += 1) {
    out.push({ key: `${id}:move:${i}`, text: `${removed[i]} → ${added[i]} ${label}` })
  }
  for (let i = moved; i < removed.length; i += 1) {
    out.push({ key: `${id}:drop:${i}`, text: `${removed[i]} dropped · ${label}` })
  }
  for (let i = moved; i < added.length; i += 1) {
    out.push({ key: `${id}:add:${i}`, text: `${added[i]} added · ${label}` })
  }
  return out
}

/**
 * The whole diff, field by field, against the record as it was loaded. This is both what the
 * "What changes for Mom" card lists and what `POST /app/medications` has to carry, so it is one
 * function and not two — the caregiver ticks the box against the same list the server is told.
 */
function diffMedicines(baseline: Medication[], rows: EditRow[]): Change[] {
  const out: Change[] = []
  const byId = new Map(rows.map((r) => [r.id, r]))

  for (const base of baseline) {
    const row = byId.get(base.id)
    if (!row) {
      out.push({ key: `${base.id}:gone`, text: `${base.name} removed` })
      continue
    }
    if (row.stopped) {
      // A stopped medicine has no remaining fields worth reporting — it stops, that is the change.
      out.push({ key: `${base.id}:stopped`, text: `${base.name} stopped` })
      continue
    }

    const typed = row.name.trim()
    const label = typed || base.name

    if (typed !== base.name) {
      out.push({
        key: `${base.id}:name`,
        text: `${base.name} renamed to ${typed || '(no name yet)'}`,
      })
    }
    if (row.dose.trim() !== base.dose) {
      out.push({
        key: `${base.id}:dose`,
        text: `${label} dose ${base.dose} → ${row.dose.trim() || '(no dose yet)'}`,
      })
    }
    out.push(...diffSlots(base.id, base.slots, row.slots, label))

    const baseFood: WithFood = base.with_food ?? 'any'
    if (row.with_food !== baseFood) {
      out.push({
        key: `${base.id}:food`,
        text: `${label} ${FOOD_LABEL[baseFood].toLowerCase()} → ${FOOD_LABEL[row.with_food].toLowerCase()}`,
      })
    }
    if (row.is_priority !== base.is_priority) {
      out.push({
        key: `${base.id}:priority`,
        text: row.is_priority
          ? `${label} is now the priority dose`
          : `${label} is no longer the priority dose`,
      })
    }
  }

  for (const row of rows) {
    if (baseline.some((b) => b.id === row.id)) continue
    if (row.stopped) continue // added and stopped in the same session — nothing reaches the record
    const label = row.name.trim() || 'New medicine'
    const times = row.slots.length > 0 ? row.slots.join(', ') : 'no times yet'
    out.push({ key: `${row.id}:new`, text: `${label} added · ${times}` })
  }

  const before = baseline.length
  const after = rows.filter((r) => !r.stopped).length
  if (before !== after) {
    out.push({ key: 'count', text: `${before} → ${after} medicines` })
  }

  return out
}

/* ------------------------------------------------------------- the uploader */

/** No upload endpoint exists in this build (same as `setup/Prescription.tsx`), so the three
 *  entry points append a plausible file and animate it to done. The shape of the flow is the
 *  point; the bytes are Lane B's. */
const FAKE_FILES = [
  { name: 'Dr_Rao_Sep12.jpg', size: 1_884_160 },
  { name: 'Repeat_script.pdf', size: 612_352 },
]
const UPLOAD_MS = 1200
const TICK_MS = 80

function nameFor(index: number): { name: string; size: number } {
  const seed = FAKE_FILES[index % FAKE_FILES.length]
  const pass = Math.floor(index / FAKE_FILES.length)
  if (pass === 0) return seed
  return { ...seed, name: seed.name.replace(/(\.\w+)$/, `_${pass + 1}$1`) }
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

/* -------------------------------------------------------------- the screen */

export default function MedicinesEdit() {
  const navigate = useNavigate()
  const record = useCareRecord()

  const [params] = useSearchParams()
  // Calendar's two CTAs land here: one on the list, one on the uploader (1g).
  const [tab, setTab] = useState<'edit' | 'upload'>(params.get('tab') === 'upload' ? 'upload' : 'edit')

  /** The record as it was read. The diff — and therefore the consent — is against this. */
  const [baseline, setBaseline] = useState<Medication[] | null>(null)
  const [rows, setRows] = useState<EditRow[]>([])

  /** `${id}:${index}` of the slot chip currently open as a time editor. */
  const [editingSlot, setEditingSlot] = useState<string | null>(null)
  const [stopMode, setStopMode] = useState(false)
  const [consent, setConsent] = useState(false)
  const [files, setFiles] = useState<UploadFile[]>([])

  /**
   * Seed once. `useCareRecord` polls, so re-seeding on every successful refetch would throw the
   * caregiver's half-typed dose away every five seconds; the baseline is the record as first read
   * and stays that way for the life of the screen.
   */
  useEffect(() => {
    if (baseline || !record.data) return
    setBaseline(record.data.medications)
    setRows(record.data.medications.map(toRow))
  }, [record.data, baseline])

  /* -------- uploads (local to this screen — nothing is written to the setup draft) -------- */

  const filesRef = useRef<UploadFile[]>([])
  filesRef.current = files
  const timers = useRef<number[]>([])
  const seq = useRef(0)

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(window.clearInterval)
  }, [])

  /**
   * Every write goes through here. It re-opens the gate: a tick that survived an edit would be
   * attached to a diff the caregiver never read.
   */
  function commit(next: EditRow[]) {
    setRows(next)
    setConsent(false)
  }

  function update(id: string, changes: Partial<EditRow>) {
    commit(rows.map((r) => (r.id === id ? { ...r, ...changes } : r)))
  }

  /** FR-2 / TRD §3: priority is exclusive — switching one on switches every other one off,
   *  in the same commit, so the record never briefly holds two. */
  function setPriority(id: string, on: boolean) {
    commit(
      rows.map((r) => {
        if (on) return { ...r, is_priority: r.id === id && !r.stopped }
        return r.id === id ? { ...r, is_priority: false } : r
      }),
    )
  }

  function setSlot(id: string, index: number, time: string) {
    // <input type="time"> emits '' mid-edit; committing that makes an unschedulable row.
    if (!time) return
    const row = rows.find((r) => r.id === id)
    if (!row) return
    update(id, { slots: row.slots.map((s, i) => (i === index ? time : s)) })
  }

  function addSlot(id: string) {
    const row = rows.find((r) => r.id === id)
    if (!row) return
    update(id, { slots: [...row.slots, '08:00'] })
    setEditingSlot(`${id}:${row.slots.length}`)
  }

  function removeSlot(id: string, index: number) {
    const row = rows.find((r) => r.id === id)
    if (!row) return
    update(id, { slots: row.slots.filter((_, i) => i !== index) })
    setEditingSlot(null)
  }

  function addMedicine() {
    commit([
      ...rows,
      {
        id: newId(),
        name: '',
        dose: '',
        slots: ['08:00'],
        with_food: 'any',
        is_priority: false,
        stopped: false,
        isNew: true,
      },
    ])
  }

  /** Stopping keeps the row and drops its priority — a stopped medicine cannot be the one dose
   *  the agent chases hardest. Restoring does not hand the priority back; that is a fresh choice. */
  function setStopped(id: string, stopped: boolean) {
    commit(rows.map((r) => (r.id === id ? { ...r, stopped, is_priority: stopped ? false : r.is_priority } : r)))
    setStopMode(false)
  }

  /** Only for rows added on this screen — nothing that exists in the record is ever deleted here. */
  function discardNew(id: string) {
    commit(rows.filter((r) => r.id !== id))
  }

  function addFile() {
    const { name, size } = nameFor(filesRef.current.length)
    const id = `f${Date.now()}-${(seq.current += 1)}`
    const next = [...filesRef.current, { id, name, size, progress: 0 }]
    filesRef.current = next
    setFiles(next)
    setConsent(false) // the attachment is part of what is being submitted

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const pct = Math.min(100, Math.round(((Date.now() - startedAt) / UPLOAD_MS) * 100))
      const updated = filesRef.current.map((f) => (f.id === id ? { ...f, progress: pct } : f))
      filesRef.current = updated
      setFiles(updated)
      if (pct >= 100) window.clearInterval(timer)
    }, TICK_MS)
    timers.current.push(timer)
  }

  function removeFile(id: string) {
    const next = filesRef.current.filter((f) => f.id !== id)
    filesRef.current = next
    setFiles(next)
    setConsent(false)
  }

  const changes = useMemo(() => diffMedicines(baseline ?? [], rows), [baseline, rows])

  /** A row that cannot generate a dose event must not be signable — a stopped row is exempt,
   *  it generates nothing by design. */
  const incomplete = rows.filter(
    (r) =>
      !r.stopped &&
      (!r.name.trim() ||
        !r.dose.trim() ||
        r.slots.length === 0 ||
        r.slots.some((t) => !/^\d{2}:\d{2}$/.test(t))),
  ).length

  const uploading = files.some((f) => f.progress < 100)
  const gateOpen = changes.length > 0 && incomplete === 0 && !uploading
  const canSave = gateOpen && consent

  const [submitted, setSubmitted] = useState(false)

  function saveAndContinue() {
    /**
     * TODO(Lane B): there is no mutation endpoint yet, so this is a deliberate no-op.
     *
     * Needed: `POST /app/medications`, carrying
     *   · the diff computed above (`diffMedicines`) as the `diff` JSONB,
     *   · `consent_text: CONSENT_TEXT` — the string verbatim, not a boolean,
     *   · `consent_ack: true`, `changed_by` = the signed-in caregiver,
     *   · the uploaded prescription file ids, when any were attached.
     *
     * That is the `medication_changes` audit row specified in docs/SCHEMA-GAPS-LANE-C.md §3.
     *
     * Until it exists this must NOT navigate to /calendar: the calendar would render the old
     * schedule and read as a bug rather than as an unfinished integration. So it stays on the
     * screen and says plainly that the change is held, not sent.
     */
    setSubmitted(true)
  }

  if (record.isLoading) return <LoadingBlock rows={6} />
  if (record.error) return <ErrorBlock error={record.error} onRetry={() => record.refetch()} />
  if (!record.data || !baseline) return <LoadingBlock rows={6} />

  const active = rows.filter((r) => !r.stopped).length

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
      {/* ---------------------------------------------------------------- header */}
      <Row className="flex-wrap gap-2">
        <button
          type="button"
          onClick={() => navigate('/calendar')}
          aria-label="Back"
          className="-ml-1 grid size-8 shrink-0 place-items-center rounded-md text-lg text-muted"
        >
          ←
        </button>
        <h1 className="flex-1 text-lg font-bold">Change medicines</h1>
        <Label>
          {active} {active === 1 ? 'med' : 'meds'}
        </Label>
      </Row>

      {/* segmented control — 1G.2 / 2F.2. Switching flows is not an edit, so it leaves the tick. */}
      <div role="group" aria-label="Change medicines" className="flex gap-1.5">
        {(
          [
            ['edit', 'Edit medicine'],
            ['upload', 'Upload prescription'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={clsx(
              'flex-1 rounded-full border px-3 py-2 text-base font-semibold',
              tab === key
                ? 'border-ink bg-ink text-white'
                : 'border-line-strong bg-paper text-muted-strong',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'edit' ? (
        <>
          {rows.length === 0 ? (
            <EmptyBlock
              title="No medicines on the record"
              body="Nothing is scheduled yet. Add one here, or attach a prescription and we read it for you."
              action={
                <Row className="gap-2">
                  <Button onClick={addMedicine}>Add medicine</Button>
                  <Button variant="outline" onClick={() => setTab('upload')}>
                    Upload prescription
                  </Button>
                </Row>
              }
            />
          ) : (
            <>
              {/* column strip — 2F.2's spreadsheet header, desktop only */}
              <div className={clsx('hidden px-3 sm:block', GRID)}>
                <Label>Medicine</Label>
                <Label>Dose · per dose</Label>
                <Label>Frequency</Label>
                <Label>Times</Label>
                <Label>Food rule</Label>
                <Label>Priority</Label>
              </div>

              {stopMode && (
                <Card emphasis="rule">
                  <Row className="flex-wrap gap-2">
                    <Tag>stopping</Tag>
                    <span className="flex-1 text-sm text-muted-strong">
                      Pick the medicine to stop. The row stays on the record, struck through, and can
                      be restored — stopping is not deleting.
                    </span>
                  </Row>
                </Card>
              )}

              {rows.map((row) => (
                <MedicineRow
                  key={row.id}
                  row={row}
                  stopMode={stopMode}
                  editingSlot={editingSlot}
                  onEditSlot={setEditingSlot}
                  onChange={(changed) => update(row.id, changed)}
                  onSetSlot={(i, t) => setSlot(row.id, i, t)}
                  onAddSlot={() => addSlot(row.id)}
                  onRemoveSlot={(i) => removeSlot(row.id, i)}
                  onPriority={(on) => setPriority(row.id, on)}
                  onStopped={(stopped) => setStopped(row.id, stopped)}
                  onDiscard={() => discardNew(row.id)}
                />
              ))}

              <Row className="flex-wrap gap-2">
                <Chip onClick={addMedicine}>+ Add medicine</Chip>
                <Chip on={stopMode} onClick={() => setStopMode(!stopMode)}>
                  Stop a medicine
                </Chip>
                <Label className="ml-auto">
                  {changes.length === 0
                    ? 'no changes pending'
                    : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} pending`}
                </Label>
              </Row>

              <p className="px-1 text-xs text-muted">
                Priority is the one dose the agent chases hardest — only one may hold it. Stopped
                medicines keep their history; nothing already logged is deleted.
              </p>
            </>
          )}

          {/* ------------------------------------------------ what changes for Mom */}
          <Card emphasis={changes.length > 0 ? 'rule' : 'none'}>
            <Row>
              <Label className="flex-1">What changes for Mom</Label>
              {changes.length > 0 && <Tag outline>{changes.length}</Tag>}
            </Row>

            {/* aria-live sits on a real element — the diff is announced as it is built, because
                the caregiver is agreeing to this list and not to the form above it. */}
            <div aria-live="polite">
              {changes.length === 0 ? (
                <div className="text-base text-muted-strong">
                  Nothing has changed yet. Edit a time, a dose or a food rule and the difference is
                  listed here before you sign it off.
                </div>
              ) : (
                <Row className="flex-wrap gap-1.5">
                  {changes.map((c) => (
                    <DiffChip key={c.key}>{c.text}</DiffChip>
                  ))}
                </Row>
              )}
            </div>

            <Divider />
            <div className="text-sm text-muted-strong">
              The agent uses the new schedule from the next slot onward. Nothing already logged is
              rewritten.
            </div>
          </Card>
        </>
      ) : (
        /* ------------------------------------------------- upload prescription */
        <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr] lg:items-start">
          <div className="flex flex-col gap-3">
            <Row>
              <Label className="flex-1">Attach the new prescription</Label>
              <Label>optional</Label>
            </Row>

            {/* The button is an overlay rather than a wrapper: a real <button> cannot legally
                contain Placeholder's div, and the whole zone still has to be tappable. */}
            <div
              className="relative"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFile()
              }}
            >
              <Placeholder className="h-[150px] flex-col gap-2 border-dashed">
                <span className="text-2xl leading-none">▢</span>
                <span className="text-base font-semibold text-muted-strong">
                  Drop a file, or scan
                </span>
                <span className="text-2xs">JPG · PNG · PDF</span>
              </Placeholder>
              <button
                type="button"
                onClick={addFile}
                aria-label="Scan or choose a prescription file"
                className="absolute inset-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
              />
            </div>

            {/* The same three ways in as onboarding — one uploader behind all of them. */}
            <Row className="flex-wrap gap-2">
              <Button variant="outline" className="flex-1" onClick={addFile}>
                Camera
              </Button>
              <Button variant="outline" className="flex-1" onClick={addFile}>
                Gallery
              </Button>
              <Button variant="outline" className="flex-1" onClick={addFile}>
                Files
              </Button>
            </Row>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Attached ({files.length})</Label>

            {files.length === 0 && (
              <Card className="border-dashed">
                <div className="text-sm text-muted-strong">
                  Nothing attached. The upload is optional — the consent below is not. A new
                  prescription is filed with the change so the record shows why it happened.
                </div>
              </Card>
            )}

            {files.map((f, i) => {
              const done = f.progress >= 100
              return (
                <Card key={f.id}>
                  <Row>
                    <Placeholder className="h-[40px] w-[32px] shrink-0 text-2xs">
                      pg {i + 1}
                    </Placeholder>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="truncate text-base font-semibold">{f.name}</span>
                      <Bar fill={f.progress / 100} />
                      <span className="text-2xs text-muted">
                        {done ? `${mb(f.size)} · read ✓` : `uploading · ${f.progress}%`}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      aria-label={`Remove ${f.name}`}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-base text-muted"
                    >
                      ✕
                    </button>
                  </Row>
                </Card>
              )
            })}

            <Card>
              <Row>
                <Tag outline>note</Tag>
                <span className="flex-1 text-sm text-muted-strong">
                  Attaching a file changes nothing on its own. The schedule is what the agent calls
                  about, so edit it on the other tab.
                </span>
              </Row>
            </Card>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------- the gate, pinned */}
      {/* Negative margins bleed through AppShell's <main> padding (p-4, p-6 from lg) so the
          footer sits flush on the scrollport edge. The tab bar already reserves the safe area. */}
      <footer className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col gap-2.5 border-t border-line bg-surface px-4 pt-3 pb-3 lg:-mx-6 lg:-mb-6 lg:px-6">
        <Card emphasis="rule">
          <div className="flex items-start gap-2.5">
            <input
              id="medicines-edit-consent"
              type="checkbox"
              checked={consent}
              disabled={!gateOpen}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-ink disabled:opacity-40"
            />
            <label htmlFor="medicines-edit-consent" className="flex-1 leading-snug">
              <span className="text-base font-semibold">{CONSENT_TEXT}</span>
              <br />
              <span className="text-xs text-muted-strong">
                {changes.length === 0
                  ? 'Nothing has changed yet — there is nothing to agree to.'
                  : incomplete > 0
                    ? `${incomplete} ${incomplete === 1 ? 'row needs' : 'rows need'} a name, a dose and at least one time before you can sign this off.`
                    : uploading
                      ? 'Waiting for the upload to finish…'
                      : 'Editing anything after ticking clears the tick — the consent is on the list above as you read it.'}
              </span>
            </label>
          </div>
        </Card>

        {submitted && (
          <Card emphasis="rule" className="gap-1">
            <Label>Held on this device</Label>
            <span className="text-base leading-relaxed">
              These changes and your attestation are ready to send. They reach {"Sharma-ji's"}{' '}
              schedule once the Care API accepts them — nothing has changed for them yet.
            </span>
          </Card>
        )}
        <Button disabled={!canSave || submitted} onClick={saveAndContinue} className="w-full">
          Save and Continue
        </Button>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------- a diff chip */

/**
 * Chip-shaped, but it wraps. `Chip` is `whitespace-nowrap`, which is right for a time or a
 * count and wrong for "Metformin dose 500mg → 750mg" beside a name the caregiver typed: at
 * 390px one long line would push the whole page sideways, and a horizontally scrolling
 * consent screen is a consent screen people sign without reading the end of.
 */
function DiffChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-line-strong bg-paper px-2.5 py-1 text-sm break-words">
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------- a row */

function MedicineRow({
  row,
  stopMode,
  editingSlot,
  onEditSlot,
  onChange,
  onSetSlot,
  onAddSlot,
  onRemoveSlot,
  onPriority,
  onStopped,
  onDiscard,
}: {
  row: EditRow
  stopMode: boolean
  editingSlot: string | null
  onEditSlot: (key: string | null) => void
  onChange: (changes: Partial<EditRow>) => void
  onSetSlot: (index: number, time: string) => void
  onAddSlot: () => void
  onRemoveSlot: (index: number) => void
  onPriority: (on: boolean) => void
  onStopped: (stopped: boolean) => void
  onDiscard: () => void
}) {
  const input =
    'w-full rounded-md border border-line-strong bg-paper px-2.5 py-2 text-base text-ink placeholder:text-muted'

  /* A stopped row is a receipt, not a form: it stays legible, says why it is greyed out in
     words as well as in opacity, and offers exactly one action — restore. */
  if (row.stopped) {
    return (
      <Card className={clsx('gap-2.5 opacity-70', GRID)}>
        <div className="flex min-w-0 flex-col gap-1">
          <Row className="flex-wrap gap-2">
            <span className="text-md font-semibold line-through break-words">
              {row.name || 'Untitled medicine'}
            </span>
            <Tag outline>stopped</Tag>
          </Row>
          <span className="text-2xs text-muted">{row.dose || '—'}</span>
        </div>
        <div className="text-base text-muted sm:col-span-3">no longer scheduled · from today</div>
        <div className="hidden sm:block" />
        <Row>
          <Chip onClick={() => onStopped(false)}>↺ Restore</Chip>
        </Row>
      </Card>
    )
  }

  return (
    <Card emphasis={stopMode ? 'rule' : 'none'} className={clsx('gap-2.5', GRID)}>
      {/* name */}
      <div className="flex min-w-0 flex-col gap-1">
        <Row className="sm:hidden">
          <Label className="flex-1">Medicine</Label>
          {row.isNew && <Tag outline>new</Tag>}
        </Row>
        <input
          className={clsx(input, 'font-semibold')}
          value={row.name}
          placeholder="Medicine name"
          aria-label="Medicine name"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <div className="hidden sm:block">{row.isNew && <Tag outline>new</Tag>}</div>
      </div>

      {/* dose */}
      <div className="flex min-w-0 flex-col gap-1">
        <Label className="sm:hidden">Dose · per dose</Label>
        <input
          className={input}
          value={row.dose}
          placeholder="500mg"
          aria-label="Dose per dose"
          onChange={(e) => onChange({ dose: e.target.value })}
        />
      </div>

      {/* frequency — derived, never typed */}
      <div className="flex flex-col gap-1">
        <Label className="sm:hidden">Frequency</Label>
        <div className="py-2 text-base whitespace-nowrap">{row.slots.length}× daily</div>
      </div>

      {/* times */}
      <div className="flex min-w-0 flex-col gap-1">
        <Label className="sm:hidden">Times</Label>
        <Row className="flex-wrap gap-1.5 py-1">
          {row.slots.map((slot, i) => {
            const key = `${row.id}:${i}`
            if (editingSlot === key) {
              return (
                <span key={key} className="inline-flex items-center gap-1">
                  <input
                    type="time"
                    autoFocus
                    value={slot}
                    aria-label={`Time ${i + 1} for ${row.name || 'this medicine'}`}
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
      <div className="flex min-w-0 flex-col gap-1">
        <Label className="sm:hidden">Food rule</Label>
        <select
          className={input}
          value={row.with_food}
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

      {/* priority · stop · discard */}
      <div className="flex flex-col gap-1.5">
        <Divider className="sm:hidden" />
        <Row className="flex-wrap gap-2">
          <label className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              checked={row.is_priority}
              onChange={(e) => onPriority(e.target.checked)}
              className="size-5 accent-ink"
            />
            priority
          </label>
          {row.isNew ? (
            <button
              type="button"
              onClick={onDiscard}
              aria-label={`Discard ${row.name || 'new medicine'}`}
              className="ml-auto text-sm text-muted underline"
            >
              Discard
            </button>
          ) : (
            /* Not `on` — that would publish aria-pressed on a button that is an action, not a
               toggle. Stop mode only raises the emphasis. */
            <Chip
              onClick={() => onStopped(true)}
              className={clsx('ml-auto', stopMode && 'border-ink font-semibold')}
            >
              Stop
            </Chip>
          )}
        </Row>
      </div>
    </Card>
  )
}
