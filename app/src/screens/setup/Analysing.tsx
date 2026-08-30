import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Button, Card, Chip, Dot, Label, Placeholder, Row, Tag } from '../../ui'
import { useSetupDraft } from '../../setup/store'
import type { DraftMedicine, ExtractionMeta } from '../../setup/store'
import { getFile, previewUrl } from '../../setup/files'
import { extractPrescription } from '../../api/extract'
import type { ExtractError, ExtractedSchedule } from '../../api/extract'

/**
 * Wireframe 1d (mobile) / 2c right column (web) — reading the uploaded pages.
 *
 * This screen used to play four stages on timers and then write a hardcoded fixture.
 * It now performs the real extraction: each page is POSTed to /extract, which runs the
 * VLM and returns a *reviewable* schedule. The stage list is one row per page and moves
 * only when that page's request actually resolves, so the elapsed times are measured
 * rather than scripted.
 *
 * Three properties this screen must not lose:
 *
 *  · A refusal is not an empty page. If the model declines to read an image, that comes
 *    back as `kind: 'blocked'` and is shown as "this was not read". It must never be
 *    rendered as a prescription with no medicines on it — that is a schedule someone
 *    might sign off.
 *  · A page that failed is named. Partial success across several pages is reported as
 *    partial, never quietly presented as the whole prescription.
 *  · Nothing here is confirmed. The next screen holds the sign-off gate, and reaching
 *    it is not the same as passing it.
 */

interface PageState {
  id: string
  name: string
  status: 'pending' | 'reading' | 'done' | 'failed'
  ms?: number
  error?: ExtractError
  schedule?: ExtractedSchedule
}

/** Extraction rows -> the draft shape, carrying the review provenance across. */
function toDraftMedicines(schedules: ExtractedSchedule[]): DraftMedicine[] {
  return schedules.flatMap((s) =>
    s.medicines.map((m) => ({
      id: m.id,
      name: m.name,
      dose: m.dose,
      slots: m.slots,
      with_food: m.with_food,
      is_priority: false,
      unclear: m.unclear,
      raw_line: m.raw_line,
      confidence: m.confidence,
      flags: m.flags,
      duration_days: m.duration_days,
      excluded: m.excluded,
      exclusion_reason: m.exclusion_reason,
    })),
  )
}

function mergeMeta(schedules: ExtractedSchedule[], sourceFiles: string[]): ExtractionMeta {
  return {
    doc_id: schedules.map((s) => s.doc_id).join(','),
    model: schedules[0]?.model ?? '',
    source_files: sourceFiles,
    needs_review: schedules.some((s) => s.needs_review),
    review_reasons: [...new Set(schedules.flatMap((s) => s.review_reasons))],
    unparsed_lines: schedules.flatMap((s) => s.unparsed_lines),
  }
}

export default function Analysing() {
  const navigate = useNavigate()
  const { draft, patch } = useSetupDraft()

  const [pages, setPages] = useState<PageState[]>(() =>
    draft.files.map((f) => ({
      id: f.id,
      name: f.name,
      status: 'pending' as const,
    })),
  )
  const [running, setRunning] = useState(false)

  /**
   * The bytes live in a session-scoped map, not in the draft — a reload keeps the file
   * list but loses the images, and re-reading is impossible until they are picked again.
   */
  const missingBytes = draft.files.length > 0 && draft.files.every((f) => !getFile(f.id))

  const fileIds = draft.files.map((f) => f.id)

  /**
   * Whether the medicines currently in the draft were read from *these* pages.
   *
   * `ocrDone` alone is not enough. It only says "a prescription has been read at some
   * point", so on its own it suppresses the re-read when the caregiver comes back with
   * a different photograph — and the previous prescription's medicines are then shown
   * beneath the new image, looking read and ready to sign. Comparing the source files
   * separates the two cases that matter: returning to the same prescription (keep the
   * rows, including any edits the caregiver has made — FR-4) and supplying a new one
   * (read it).
   */
  const readFromTheseFiles =
    draft.ocrDone &&
    draft.extraction?.source_files?.length === fileIds.length &&
    draft.extraction.source_files.every((id, i) => id === fileIds[i])

  /**
   * StrictMode invokes effects twice in development — setup, cleanup, setup — so
   * without a guard every prescription costs two billed VLM calls.
   *
   * This guard must NOT be paired with an abort in the effect's cleanup. That was the
   * original bug: cleanup aborted the only run, and the second setup hit this ref and
   * declined to start another, so the screen sat on "still reading…" forever having
   * never issued a request at all. There is deliberately no AbortController here.
   * React reuses the same fiber across a StrictMode cycle, so the state setters below
   * stay valid and the in-flight run keeps updating the screen it started on.
   *
   * The cost of not aborting is small: navigating away mid-read lets the request
   * finish and writes the result to the draft, so the caregiver finds the work done
   * when they return rather than paying for it a second time.
   */
  const started = useRef(false)

  const failRow = (id: string, message: string, retryable: boolean) =>
    setPages((p) =>
      p.map((x) =>
        x.id === id
          ? {
              ...x,
              status: 'failed' as const,
              error: {
                kind: 'network' as const,
                message,
                retryable,
                needs_human_review: false,
              },
            }
          : x,
      ),
    )

  const runExtraction = useCallback(async () => {
    setRunning(true)
    const results: ExtractedSchedule[] = []

    // Drop any earlier reading before this one starts. Left in place, the previous
    // prescription's medicines would sit under the new photograph while it reads —
    // and would survive as a signable schedule if this read then failed.
    if (draft.ocrDone) {
      patch({ medicines: [], extraction: null, ocrDone: false, scheduleConfirmed: false })
    }

    try {
      for (const f of draft.files) {
        const file = getFile(f.id)
        if (!file) {
          failRow(f.id, 'This page is no longer in memory — add it again.', false)
          continue
        }

        setPages((p) => p.map((x) => (x.id === f.id ? { ...x, status: 'reading' } : x)))
        const startedAt = performance.now()

        let result
        try {
          result = await extractPrescription(file, draft.mealTimes)
        } catch (e) {
          // Any unexpected throw still has to resolve this row. A page left in
          // 'reading' is a hang with no error and no way out — which is exactly
          // how this screen failed the first time.
          failRow(f.id, (e as Error)?.message || 'Reading this page failed unexpectedly.', true)
          continue
        }

        const ms = Math.round(performance.now() - startedAt)
        if (result.ok) {
          results.push(result.schedule)
          setPages((p) =>
            p.map((x) =>
              x.id === f.id ? { ...x, status: 'done', ms, schedule: result.schedule } : x,
            ),
          )
        } else {
          // Kept as its own kind. Never folded into "nothing was found here".
          setPages((p) =>
            p.map((x) => (x.id === f.id ? { ...x, status: 'failed', ms, error: result.error } : x)),
          )
        }
      }

      if (results.length > 0) {
        patch({
          medicines: toDraftMedicines(results),
          extraction: mergeMeta(results, fileIds),
          ocrDone: true,
          scheduleConfirmed: false,
        })
      }
    } finally {
      // Belt and braces. Whatever happens above — a throw, an early exit, a bug
      // added later — the screen must never be left claiming it is still reading.
      setRunning(false)
      setPages((p) =>
        p.map((x) =>
          x.status === 'reading' || x.status === 'pending'
            ? {
                ...x,
                status: 'failed' as const,
                error: {
                  kind: 'network' as const,
                  message: 'Reading this page stopped before it finished.',
                  retryable: true,
                  needs_human_review: false,
                },
              }
            : x,
        ),
      )
    }
  }, [draft.files, draft.mealTimes, draft.ocrDone, patch])

  useEffect(() => {
    if (started.current) return
    // Coming back to this screen must never overwrite medicines the caregiver has
    // since edited — the sign-off has to be on the list they actually saw (FR-4).
    if (readFromTheseFiles || missingBytes || draft.files.length === 0) return
    started.current = true
    void runExtraction()
  }, [readFromTheseFiles, draft.files.length, missingBytes, runExtraction])

  const done = pages.filter((p) => p.status === 'done')
  const failed = pages.filter((p) => p.status === 'failed')
  const blocked = failed.filter((p) => p.error?.kind === 'blocked')
  const settled =
    pages.length > 0 && pages.every((p) => p.status === 'done' || p.status === 'failed')

  const medicines = draft.medicines
  const unclear = medicines.filter((m) => m.unclear).length
  const excluded = medicines.filter((m) => m.excluded).length
  const unparsed = draft.extraction?.unparsed_lines ?? []

  const firstPreview = draft.files.map((f) => previewUrl(f.id)).find(Boolean)
  const canContinue = draft.ocrDone && medicines.length > 0

  const retry = () => {
    setPages(
      draft.files.map((f) => ({
        id: f.id,
        name: f.name,
        status: 'pending' as const,
      })),
    )
    void runExtraction()
  }

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-3 p-3 sm:p-5">
      <Row>
        {/* Kept from the app lane's redesign: a way back to re-upload without
            using the browser's back button. The rest of this screen is the
            implementation that actually reads the prescription. */}
        <button
          type="button"
          onClick={() => navigate('/setup/prescription')}
          aria-label="Back"
          className="-ml-1 grid size-11 place-items-center text-lg text-muted-strong"
        >
          ←
        </button>
        <h1 className="flex-1 text-base font-bold">
          {running ? 'Reading prescription…' : 'Prescription read'}
        </h1>
        <Label>step 3 / 4</Label>
      </Row>

      {missingBytes && (
        <Card emphasis="rule">
          <Label>Pages not available</Label>
          <span className="text-xs leading-relaxed text-muted-strong">
            The photos were cleared when the page reloaded — they are held in memory only, never
            saved to this device. Add them again to read the prescription.
          </span>
          <Button variant="outline" onClick={() => navigate('/setup/prescription')}>
            Back to add photos
          </Button>
        </Card>
      )}

      {/* Web 2c puts the page beside the log; a phone stacks them. The real photo goes
          here because a reviewer has to compare what was read against what was written. */}
      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr] lg:items-start">
        <div className="flex flex-col gap-2">
          {firstPreview ? (
            <img
              src={firstPreview}
              alt="The prescription being read"
              className="max-h-[210px] w-full rounded-md border border-line-strong object-contain"
            />
          ) : (
            <Placeholder className="h-[150px] flex-col gap-1 lg:h-[210px]">
              <span>no page preview</span>
            </Placeholder>
          )}
          <div className="text-2xs text-muted">
            {draft.files.length > 0
              ? `${draft.files.length} page${draft.files.length > 1 ? 's' : ''} · ${draft.files
                  .map((f) => f.name)
                  .join(' · ')}`
              : 'No pages added.'}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div aria-live="polite">
            <Card className="gap-2.5">
              {pages.length === 0 && (
                <span className="text-xs text-muted">No pages to read.</span>
              )}
              {pages.map((p, i) => (
                <Row key={p.id}>
                  <Dot
                    kind={
                      p.status === 'done' ? 'filled' : p.status === 'reading' ? 'hollow' : 'empty'
                    }
                  />
                  <span
                    className={clsx(
                      'flex-1 truncate text-xs',
                      p.status === 'reading' && 'font-semibold',
                      p.status === 'pending' && 'text-muted',
                    )}
                  >
                    {p.status === 'failed'
                      ? `Page ${i + 1} — not read`
                      : `Page ${i + 1} · ${p.name}`}
                  </span>
                  <Label>
                    {p.status === 'reading'
                      ? '…'
                      : p.ms !== undefined
                        ? `${(p.ms / 1000).toFixed(1)}s`
                        : ''}
                  </Label>
                </Row>
              ))}
            </Card>
          </div>

          <Card>
            <Label>Found so far</Label>
            <Row className="flex-wrap gap-1.5">
              {medicines.length === 0 && (
                <span className="text-xs text-muted">
                  {running ? 'still reading…' : 'nothing read yet'}
                </span>
              )}
              {medicines.map((m) => (
                <Chip key={m.id}>
                  {m.name || 'unnamed'} {m.dose}
                  {m.unclear ? ' ?' : ''}
                </Chip>
              ))}
            </Row>
            {settled && medicines.length > 0 && (
              <Row className="flex-wrap">
                {unclear > 0 && <Tag>{unclear} to check</Tag>}
                {excluded > 0 && <Tag outline>{excluded} not called</Tag>}
                <span className="flex-1 text-xs text-muted-strong">
                  You confirm every row on the next screen.
                </span>
              </Row>
            )}
          </Card>
        </div>
      </div>

      {/* A refusal is its own outcome. Saying "no medicines found" here would be a lie
          with a signature box under it. */}
      {blocked.length > 0 && (
        <Card emphasis="rule">
          <Label>Not read — needs a person to look</Label>
          <span className="text-xs leading-relaxed text-muted-strong">
            {blocked.length === 1 ? 'One page was' : `${blocked.length} pages were`} declined by the
            reader, so {blocked.length === 1 ? 'it has' : 'they have'} not been read at all. This is
            not the same as finding no medicines. Retrying will not change the result — retake the
            photo more clearly, or enter those medicines by hand on the next screen.
          </span>
        </Card>
      )}

      {failed.filter((p) => p.error?.kind !== 'blocked').length > 0 && (
        <Card emphasis="rule">
          <Label>Could not be read</Label>
          {failed
            .filter((p) => p.error?.kind !== 'blocked')
            .map((p) => (
              <span key={p.id} className="text-xs text-muted-strong">
                {p.name} — {p.error?.message}
              </span>
            ))}
          {failed.some((p) => p.error?.retryable) && !running && (
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          )}
        </Card>
      )}

      {/* Lines the model returned but could not be validated. Shown rather than dropped:
          a medicine silently discarded is one the caregiver never knows to add back. */}
      {unparsed.length > 0 && (
        <Card emphasis="rule">
          <Label>Read but not understood ({unparsed.length})</Label>
          <span className="text-xs text-muted-strong">
            These lines were on the page and could not be turned into a schedule. Add them by hand
            if they are medicines.
          </span>
          {unparsed.map((line, i) => (
            <span key={i} className="font-mono text-[10.5px] text-muted">
              {line || '(unreadable)'}
            </span>
          ))}
        </Card>
      )}

      {settled && done.length > 0 && failed.length > 0 && (
        <Card emphasis="rule">
          <span className="text-xs text-muted-strong">
            {done.length} of {pages.length} pages were read. What follows is only part of the
            prescription — check it against the paper before signing off.
          </span>
        </Card>
      )}

      {settled && medicines.length === 0 && failed.length === 0 && (
        <Card emphasis="rule">
          <span className="text-xs text-muted-strong">
            The pages were read, and no medicines were found on them. If that looks wrong, retake
            the photo with the dosage lines fully in frame.
          </span>
        </Card>
      )}

      <Button
        className="w-full"
        disabled={!canContinue}
        onClick={() => navigate('/setup/schedule')}
      >
        Continue
      </Button>
      <p className="text-2xs text-muted">
        Nothing is saved to the care record, and no call is scheduled, until you sign the schedule
        off on the next screen.
      </p>
    </section>
  )
}
