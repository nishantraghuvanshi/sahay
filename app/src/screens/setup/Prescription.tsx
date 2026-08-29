import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Label, Placeholder, Row, Tag } from '../../ui'
import { useSetupDraft } from '../../setup/store'
import type { DraftFile } from '../../setup/store'
import { dropFile, previewUrl, putFile } from '../../setup/files'

/**
 * Wireframe 1c (mobile) / 2c left column (web) — "Add prescription", step 2 of 3.
 *
 * The three entry points open real pickers — camera, gallery, files — and the drop zone
 * takes real drops, so the names, sizes and thumbnails in the queue are the caregiver's
 * own.
 *
 * Nothing is transferred from this screen. The photograph is staged in memory and sent
 * once, on 1d, as part of the extraction request — so there is no progress bar here,
 * because there is no transfer to report. An animated one would have been describing a
 * network call that never happened.
 *
 * The accepted types are narrower than a picker would allow: the extractor reads JPEG
 * and PNG, and its mime sniffer silently falls back to JPEG for anything else, so a PDF
 * would be handed to the model as a broken image. Better to say no here than to let a
 * confident misreading of garbage reach a schedule.
 */

const MAX_BYTES = 10 * 1_048_576
const ACCEPT = 'image/jpeg,image/png'

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

const isAccepted = (file: File) =>
  file.type === 'image/jpeg' || file.type === 'image/png' || /\.(jpe?g|png)$/i.test(file.name)

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

  const seq = useRef(0)

  /** Files the picker handed back that we will not take — shown, not swallowed. */
  const [rejected, setRejected] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)

  const cameraInput = useRef<HTMLInputElement | null>(null)
  const galleryInput = useRef<HTMLInputElement | null>(null)
  const filesInput = useRef<HTMLInputElement | null>(null)

  const writeFiles = useCallback(
    (next: DraftFile[]) => {
      filesRef.current = next // close the window before the next tick reads it
      patch({ files: next })
    },
    [patch],
  )

  const addFiles = useCallback(
    (picked: FileList | File[] | null) => {
      const list = Array.from(picked ?? [])
      if (list.length === 0) return

      const bad: string[] = []
      const accepted: DraftFile[] = []

      for (const file of list) {
        if (!isAccepted(file)) {
          bad.push(`${file.name} — JPG or PNG photo only`)
          continue
        }
        if (file.size > MAX_BYTES) {
          bad.push(`${file.name} — ${mb(file.size)}, over the 10 MB limit`)
          continue
        }
        const id = `f${Date.now()}-${(seq.current += 1)}`
        // The bytes go to the session store; only metadata goes in the draft, which
        // is localStorage-backed and must never hold a prescription image.
        putFile(id, file)
        // `progress` stays in DraftFile for schema compatibility. Staging is
        // instantaneous, so it is complete the moment the file is accepted.
        accepted.push({
          id,
          name: file.name,
          size: file.size,
          type: file.type,
          progress: 100,
        })
      }

      setRejected(bad)
      if (accepted.length === 0) return
      writeFiles([...filesRef.current, ...accepted])
    },
    [writeFiles],
  )

  const removeFile = useCallback(
    (id: string) => {
      dropFile(id)
      writeFiles(filesRef.current.filter((f) => f.id !== id))
    },
    [writeFiles],
  )

  /** Same input reused for repeat picks — clearing the value re-fires change on the same file. */
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files)
    e.target.value = ''
  }

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

      {/* Hidden inputs — the visible controls are the buttons below. `capture` asks a phone
          for the rear camera; a desktop browser ignores it and opens the file dialog. */}
      <input
        ref={cameraInput}
        type="file"
        accept={ACCEPT}
        capture="environment"
        onChange={onPick}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={galleryInput}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={onPick}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={filesInput}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={onPick}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Web 2c stands the queue beside the drop zone; a phone stacks them. */}
      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        <div className="flex flex-col gap-3">
          {/* The button is an overlay rather than a wrapper: a real <button> cannot legally
              contain Placeholder's div, and the whole zone still has to be tappable. */}
          <div
            className="relative"
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              addFiles(e.dataTransfer.files)
            }}
          >
            <Placeholder
              className={`h-[180px] flex-col gap-2 border-dashed ${dragging ? 'border-ink' : ''}`}
            >
              <span className="text-[22px] leading-none">▢</span>
              <span className="text-[12px] font-semibold text-muted-strong">
                {dragging ? 'Drop to add' : 'Tap to scan, or drop a file'}
              </span>
              <span className="text-[9px]">JPG · PNG · up to 10 MB</span>
            </Placeholder>
            <button
              type="button"
              onClick={() => filesInput.current?.click()}
              aria-label="Scan or choose a prescription file"
              className="absolute inset-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            />
          </div>

          {/* The three ways in the client asked for. Same queue behind each. */}
          <Row className="gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => cameraInput.current?.click()}
            >
              Camera
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => galleryInput.current?.click()}
            >
              Gallery
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => filesInput.current?.click()}
            >
              Files
            </Button>
          </Row>

          {rejected.length > 0 && (
            <Card emphasis="rule" aria-live="polite">
              <Label>Not added</Label>
              {rejected.map((r) => (
                <span key={r} className="text-[11px] text-muted-strong">
                  {r}
                </span>
              ))}
            </Card>
          )}
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
            const preview = previewUrl(f.id)
            return (
              <Card key={f.id}>
                <Row>
                  {preview ? (
                    <img
                      src={preview}
                      alt=""
                      className="h-[42px] w-[34px] shrink-0 rounded-md border border-line-strong object-cover"
                    />
                  ) : (
                    <Placeholder className="h-[42px] w-[34px] shrink-0 text-[9px]">
                      {`pg ${i + 1}`}
                    </Placeholder>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="truncate text-[12px] font-semibold">{f.name}</span>
                    <span className="text-[9.5px] text-muted">{mb(f.size)} · ready to read</span>
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
        disabled={files.length === 0}
        onClick={() => navigate('/setup/analysing')}
      >
        Analyse prescription
      </Button>
      <p className="text-[10px] text-muted">
        Three ways in — camera, gallery, files. The photo is sent when you tap analyse, and it is
        not stored after the schedule has been read from it.
      </p>
    </section>
  )
}
