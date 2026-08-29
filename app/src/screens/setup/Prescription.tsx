import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, Button, Card, Label, Placeholder, Row, Tag } from '../../ui'
import { useSetupDraft } from '../../setup/store'
import type { DraftFile } from '../../setup/store'

/**
 * Wireframe 1c (mobile) / 2c left column (web) — "Add prescription", step 2 of 3.
 *
 * There is no upload endpoint in this build, so the three entry points all append a
 * plausible-looking file and animate it to done. The point of the screen for the demo is
 * the *shape* of the flow — three ways in, a visible queue, a CTA that only lights up once
 * something is actually there — not the bytes.
 */

/** Names come from the mock fixture's doctor (Dr Rao) so 1c → 1d → 1e reads as one story. */
const FAKE_FILES = [
  { name: 'Dr_Rao_Aug29.jpg', size: 1_884_160 },
  { name: 'Lab_notes.pdf', size: 612_352 },
]

const UPLOAD_MS = 1200
const TICK_MS = 80

/** progress is a 0–100 percentage — the same number the caption prints. */
function nameFor(index: number): { name: string; size: number } {
  const seed = FAKE_FILES[index % FAKE_FILES.length]
  const pass = Math.floor(index / FAKE_FILES.length)
  if (pass === 0) return seed
  return { ...seed, name: seed.name.replace(/(\.\w+)$/, `_${pass + 1}$1`) }
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

export default function Prescription() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()

  /**
   * Upload ticks fire outside the render cycle, so they read and write the newest list
   * through a ref. Closing over `draft.files` would let two concurrent uploads clobber
   * each other, and `patch` merges against localStorage rather than against React state.
   */
  const filesRef = useRef<DraftFile[]>(draft.files)
  filesRef.current = draft.files

  const timers = useRef<number[]>([])
  const seq = useRef(0)

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(window.clearInterval)
  }, [])

  const writeFiles = useCallback(
    (next: DraftFile[]) => {
      filesRef.current = next // close the window before the next tick reads it
      patch({ files: next })
    },
    [patch],
  )

  const addFile = useCallback(() => {
    const { name, size } = nameFor(filesRef.current.length)
    const id = `f${Date.now()}-${(seq.current += 1)}`
    writeFiles([...filesRef.current, { id, name, size, progress: 0 }])

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const pct = Math.min(100, Math.round(((Date.now() - startedAt) / UPLOAD_MS) * 100))
      writeFiles(filesRef.current.map((f) => (f.id === id ? { ...f, progress: pct } : f)))
      if (pct >= 100) window.clearInterval(timer)
    }, TICK_MS)
    timers.current.push(timer)
  }, [writeFiles])

  const removeFile = useCallback(
    (id: string) => writeFiles(filesRef.current.filter((f) => f.id !== id)),
    [writeFiles],
  )

  const files = draft.files

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-3 p-3 sm:p-5">
      <Row>
        <button
          type="button"
          onClick={() => navigate('/setup/parent')}
          aria-label="Back"
          className="-ml-1 grid size-8 shrink-0 place-items-center rounded-md text-[15px] text-muted"
        >
          ←
        </button>
        <h1 className="flex-1 text-[15px] font-bold">Add prescription</h1>
        <Label>2/3</Label>
      </Row>

      {/* Web 2c stands the queue beside the drop zone; a phone stacks them. */}
      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        <div className="flex flex-col gap-3">
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
            <Placeholder className="h-[180px] flex-col gap-2 border-dashed">
              <span className="text-[22px] leading-none">▢</span>
              <span className="text-[12px] font-semibold text-muted-strong">
                Tap to scan, or drop a file
              </span>
              <span className="text-[9px]">JPG · PNG · PDF · up to 10 pages</span>
            </Placeholder>
            <button
              type="button"
              onClick={addFile}
              aria-label="Scan or choose a prescription file"
              className="absolute inset-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            />
          </div>

          {/* The three ways in the client asked for. Same uploader behind each. */}
          <Row className="gap-2">
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
          <Label>Added ({files.length})</Label>

          {files.length === 0 && (
            <Card className="border-dashed">
              <div className="text-[11px] text-muted-strong">
                Nothing added yet. A photo of the paper is enough — we read it on the next screen.
              </div>
            </Card>
          )}

          {files.map((f, i) => {
            const done = f.progress >= 100
            return (
              <Card key={f.id}>
                <Row>
                  <Placeholder className="h-[42px] w-[34px] shrink-0 text-[9px]">
                    pg {i + 1}
                  </Placeholder>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="truncate text-[12px] font-semibold">{f.name}</span>
                    <Bar fill={f.progress / 100} />
                    <span className="text-[9.5px] text-muted">
                      {done ? `${mb(f.size)} · read ✓` : `uploading · ${f.progress}%`}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFile(f.id)}
                    aria-label={`Remove ${f.name}`}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-[12px] text-muted"
                  >
                    ✕
                  </button>
                </Row>
              </Card>
            )
          })}

          <Card>
            <Row>
              <Tag outline>tip</Tag>
              <span className="flex-1 text-[11px] text-muted-strong">
                Flatten the page and keep dosage lines in frame.
              </span>
            </Row>
          </Card>
        </div>
      </div>

      <Button
        className="w-full"
        disabled={files.length === 0 || files.some((f) => f.progress < 100)}
        onClick={() => navigate('/setup/analysing')}
      >
        Analyse prescription
      </Button>
      {files.some((f) => f.progress < 100) && (
        <p className="text-center text-[11px] text-muted">Waiting for the upload to finish…</p>
      )}
      <p className="text-[10px] text-muted">
        Three ways in — camera, gallery, files. The same uploader is reused whenever a new
        prescription arrives.
      </p>
    </section>
  )
}
