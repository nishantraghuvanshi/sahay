import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useHandoff } from '../api/hooks'
import type { HandoffView } from '../api/types'

/**
 * `/h/:token` — the third-party surface (PRD §4.3, TRD §11, FR-17, FR-27, NFR-8).
 *
 * Read by a STRANGER: a neighbour, a relative who just arrived, a clinic intake desk.
 * No login, no install, no navigation into the caregiver app — the reader is not a user
 * of this product and must never be offered one thing to tap that is not the phone number.
 *
 * NOTE (design system, Aug 30): this screen is deliberately EXEMPT from the app-wide
 * type scale in index.css. The pixel budget below is measured against these exact sizes,
 * so the sizes stay literal here. It still inherits the palette for free, because every
 * colour is read through a Tailwind token class (bg-paper, text-muted-strong, border-line).
 * No webfont is loaded for this screen either: it assumes one bar of signal.
 *
 * Three rules drive every layout decision below:
 *
 *  1. 🔑 The P1 block fits ONE 390×844 screen with no scrolling. Measured budget,
 *     worst case (every value wrapping to its second line):
 *
 *       provenance strip           45px   18 padding + 2 lines @13 + 1 hairline
 *       patient name             + 42px   10 margin + 32 line
 *       priority + rule band     + 60px    8 margin + 16 padding + 2 lines
 *       chief complaint          + 81px   12 margin + 13 label + 4 + 2 lines @26
 *       onset/responsive/breathing+71px    8 margin + 16 padding + 13 label + 2 lines @16
 *       allergies block          + 69px    8 margin + 21 header bar + 16 padding + 24
 *       callback tel link        + 62px    8 margin + 54 tap target
 *       fold hint                + 29px   16 padding + 13 line
 *                                -----
 *                                 459px   (491px in the "None recorded" allergy state,
 *                                          which adds two lines of caution copy;
 *                                          417px with the demo fixture's actual strings)
 *
 *     Safari on a 390×844 handset keeps roughly 660px of viewport after its own top and
 *     bottom chrome — 459 + ~180px of chrome ≤ 640px of the 844 available — so the block
 *     clears the fold with ~200px of slack even when every line wraps. Everything else
 *     scrolls below the fold hint.
 *
 *  2. No webfont, no image, no animation, no icon set — one bar of signal is the
 *     assumption. Type and hairlines only; `system-ui` is already the app's stack.
 *
 *  3. Nothing is ever blank. A field the agent never captured says "not captured",
 *     because a stranger cannot tell an empty box from a missing answer.
 *
 * Deliberately NOT importing `../ui`: those primitives are tuned for the caregiver app's
 * card rhythm. This screen owns its own vertical budget down to the pixel.
 */

/* ------------------------------------------------------------------ helpers */

/** First non-empty value, else null — an untrimmed '' is treated as never captured. */
function firstText(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 'yes' → 'Yes'. Values arrive as the agent wrote them; only the first letter is touched. */
function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], CLOCK)
}

/** 'today' · 'tomorrow' · 'on 31 August' — a plain sentence, never a raw timestamp. */
function dayWord(iso: string, now: Date = new Date()): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(new Date(iso)) - midnight(now)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return `on ${new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'long' })}`
}

/** +919876543210 → '+91 98765 43210'. Anything else is shown exactly as stored. */
function readableNumber(raw: string): string {
  const indian = /^\+91(\d{5})(\d{5})$/.exec(raw.replace(/\s/g, ''))
  return indian ? `+91 ${indian[1]} ${indian[2]}` : raw
}

/**
 * PR-3: the level alone is never enough — the cited rule is rendered literally, and the
 * stored string already begins with 'rule:' so it is never prefixed twice.
 */
function ruleText(rule: string | null): string {
  const text = rule?.trim()
  if (!text) return 'no rule recorded'
  return /^rule\b/i.test(text) ? text : `rule: ${text}`
}

/** The full 'P1 · rule: chest complaint with age over 40' string, level never alone. */
function priorityLine(level: string | null, rule: string | null): string {
  return `${level ?? 'Priority not set'} · ${ruleText(rule)}`
}

const NONE_RECORDED = /^(none|nil|no|nope|none known|no known allergies|na|n\/a)$/i

/* --------------------------------------------------------------- fragments */

function NotCaptured() {
  return <span className="text-muted-strong italic">not captured</span>
}

/** A value, or the explicit absence of one. Never an empty node. */
function Value({ text }: { text: string | null }) {
  return text ? <>{text}</> : <NotCaptured />
}

/** Small-caps section heading. Level is explicit so the reading order stays sane. */
function Heading({ children, id }: { children: string; id?: string }) {
  return (
    <h2 id={id} className="text-[10px] font-bold tracking-[0.10em] text-muted-strong uppercase">
      {children}
    </h2>
  )
}

function BelowFold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-3">
      <Heading>{title}</Heading>
      <div className="mt-1 text-[13px] leading-[18px]">{children}</div>
    </section>
  )
}

/**
 * The only thing this screen renders when there is no record: one human sentence.
 * Never a stack trace, never a blank page, never an error boundary (TRD §11).
 */
function Notice({ title, body, aside }: { title: string; body: string; aside?: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-[430px] flex-col justify-center bg-paper px-6 py-10">
      <h1 className="text-[22px] leading-[28px] font-bold">{title}</h1>
      <p className="mt-3 text-[14px] leading-[21px]">{body}</p>
      {aside && <p className="mt-4 text-[11px] leading-[16px] text-muted-strong">{aside}</p>}
    </main>
  )
}

/* ------------------------------------------------------------------ screen */

export default function Handoff() {
  const { token } = useParams<{ token: string }>()
  const { data, error, isPending } = useHandoff(token)

  if (!token) {
    return (
      <Notice
        title="This link is not complete"
        body="The part of the link that identifies the record is missing. It was probably cut short when it was copied."
        aside="Ask the person who sent it to send the whole link again."
      />
    )
  }

  if (error) {
    const code = error instanceof ApiError ? error.code : 'unknown'
    if (code === 'expired') {
      return (
        <Notice
          title="This link has expired"
          body="A Kinvox handoff link stops working 24 hours after it is created, so a medical record cannot sit open on the internet."
          aside="The record itself has not been deleted. Ask the family member who sent this link to send a new one."
        />
      )
    }
    if (code === 'not_found') {
      return (
        <Notice
          title="This link does not open a record"
          body="No record matches this link. It may have been mistyped, or shortened by the app it was sent through."
          aside="Nothing has been deleted. Ask the person who sent it to send the link again."
        />
      )
    }
    return (
      <Notice
        title="This record could not be loaded"
        body="The connection to Kinvox failed, so nothing can be shown here. Pulling the page down to reload it may work."
        aside="If it keeps failing, call the family member who sent you this link."
      />
    )
  }

  if (isPending || !data) {
    return (
      <main className="mx-auto max-w-[430px] bg-paper px-4 py-6" aria-busy="true">
        <p className="text-[13px] text-muted-strong">Opening the record…</p>
      </main>
    )
  }

  return <Record view={data} />
}

/* ------------------------------------------------------------------ record */

function Record({ view }: { view: HandoffView }) {
  const { patient, intake, medications } = view
  const f = intake.fields

  const displayName = firstText(
    [patient.name, patient.honorific].filter(Boolean).join('-'),
    f.patient_identity,
  )
  const identity = displayName
    ? patient.age != null
      ? `${displayName}, ${patient.age}`
      : displayName
    : null

  const complaint = firstText(f.chief_complaint)
  const onset = firstText(f.onset_time)
  const responsive = firstText(f.responsive)
  const breathing = firstText(f.breathing)
  const location = firstText(f.location, patient.address_text)
  const conditions = firstText(f.known_conditions, patient.conditions.join(', '))
  const statedMeds = firstText(f.current_medications)
  const caller = firstText(f.caller_identity)
  const callback = firstText(view.callback_number, f.callback_number)

  const allergyRaw = firstText(f.known_allergies, patient.allergies.join(', '))
  const allergies = allergyRaw && !NONE_RECORDED.test(allergyRaw) ? allergyRaw : null

  const captured = Math.round(intake.completeness * 12)

  return (
    <main className="mx-auto min-h-screen max-w-[430px] bg-paper px-4 pb-10 text-ink">
      {/* Why a stranger is holding a stranger's medical record. */}
      <header className="border-b border-line py-[9px]">
        <p className="text-[10px] leading-[13px] text-muted-strong">
          Emergency handoff from <strong className="font-semibold text-ink">Kinvox</strong>, the
          care line this family uses. Their family made this record during the call and sent it
          to you. Read-only — nothing to sign in to, nothing to change.
        </p>
      </header>

      {/* ---------------------------------------------- above the fold: the P1 block */}

      <h1 className="mt-[10px] text-[27px] leading-[32px] font-bold tracking-[-0.01em]">
        {identity ?? 'Name not captured'}
      </h1>

      <p className="mt-2 rounded-md bg-ink px-3 py-2 text-[13px] leading-[16px] font-semibold text-white">
        <span className="text-[17px] leading-[20px] font-bold">
          {intake.priority ?? 'Priority not set'}
        </span>
        <span aria-hidden="true" className="mx-1.5">·</span>
        <span>{ruleText(intake.priority_rule)}</span>
      </p>

      <section className="mt-3" aria-labelledby="complaint">
        <Heading id="complaint">What they said — their exact words</Heading>
        <p className="mt-1 text-[21px] leading-[26px] font-semibold break-words">
          {complaint ? `“${complaint}”` : <NotCaptured />}
        </p>
      </section>

      <dl className="mt-2 grid grid-cols-3 gap-x-2 rounded-md border border-line-strong px-3 py-2">
        <div>
          <dt className="text-[10px] font-bold tracking-[0.10em] text-muted-strong uppercase">
            Started
          </dt>
          <dd className="mt-0.5 text-[13px] leading-[16px] font-semibold break-words">
            <Value text={onset} />
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold tracking-[0.10em] text-muted-strong uppercase">
            Responsive
          </dt>
          <dd className="mt-0.5 text-[13px] leading-[16px] font-semibold break-words">
            {responsive ? sentence(responsive) : <NotCaptured />}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold tracking-[0.10em] text-muted-strong uppercase">
            Breathing
          </dt>
          <dd className="mt-0.5 text-[13px] leading-[16px] font-semibold break-words">
            {breathing ? sentence(breathing) : <NotCaptured />}
          </dd>
        </div>
      </dl>

      {/* The one block a stranger scans before handing over any medicine. */}
      <section className="mt-2 rounded-md border-2 border-ink" aria-labelledby="allergies">
        <h2
          id="allergies"
          className="rounded-t-[4px] bg-ink px-2 py-1 text-[10px] font-extrabold tracking-[0.14em] text-white uppercase"
        >
          Allergies
        </h2>
        <div className="px-3 py-2">
          <p className="text-[19px] leading-[24px] font-bold break-words">
            {allergies ?? 'None recorded'}
          </p>
          {!allergies && (
            <p className="mt-1 text-[11px] leading-[14px] font-semibold">
              No allergy was ever written down for this person. That is not the same as knowing
              they have none — ask before giving anything.
            </p>
          )}
        </div>
      </section>

      {callback ? (
        <a
          href={`tel:${callback.replace(/[^\d+]/g, '')}`}
          className="mt-2 flex min-h-[54px] items-center justify-between rounded-md border-2 border-ink px-3 py-2"
        >
          <span className="text-[10px] font-bold tracking-[0.10em] text-muted-strong uppercase">
            Call
            <br />
            back
          </span>
          <span className="text-[20px] leading-[24px] font-bold">{readableNumber(callback)}</span>
        </a>
      ) : (
        <p className="mt-2 rounded-md border border-line-strong px-3 py-3 text-[13px]">
          Callback number <NotCaptured />
        </p>
      )}

      <p className="py-2 text-[10px] leading-[13px] text-muted-strong">
        Medicines, address, conditions and this link’s expiry are below.
      </p>

      {/* ---------------------------------------------- below the fold: the rest */}

      <div className="flex flex-col gap-3">
        <BelowFold title="Where they are">
          <Value text={location} />
        </BelowFold>

        <BelowFold title="Medicines on record">
          {medications.length === 0 && !statedMeds ? (
            <NotCaptured />
          ) : (
            <>
              {medications.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {medications.map((m) => (
                    <li key={`${m.name}-${m.dose}`}>
                      <strong className="font-semibold">
                        {m.name} {m.dose}
                      </strong>
                      <span className="text-muted-strong">
                        {m.slots.length > 0 ? ` — ${m.slots.join(', ')}` : ''}
                        {m.with_food === 'before'
                          ? ' · before food'
                          : m.with_food === 'after'
                            ? ' · after food'
                            : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[12px] leading-[16px] text-muted-strong">
                Said on the call: <Value text={statedMeds} />
              </p>
            </>
          )}
        </BelowFold>

        <BelowFold title="Conditions on record">
          <Value text={conditions} />
        </BelowFold>

        <BelowFold title="Priority and the rule that set it">
          <span className="font-semibold">{priorityLine(intake.priority, intake.priority_rule)}</span>
          <p className="mt-1 text-[12px] leading-[16px] text-muted-strong">
            The priority was set by that written rule, not by a judgement about this person.
          </p>
        </BelowFold>

        <BelowFold title="How this record was made">
          <p>
            Kinvox is the phone line this family uses to check on their parent. This record was
            written while the call was happening, from what was said on it.
          </p>
          <p className="mt-1">
            Who called: <Value text={caller} />
          </p>
          <p className="mt-1">
            Person on the record: <Value text={firstText(f.patient_identity, identity)} />
          </p>
          <p className="mt-1 text-[12px] text-muted-strong">
            {captured} of 12 details were captured on the call.
          </p>
        </BelowFold>

        <BelowFold title="This link">
          <p>
            {view.expires_at
              ? `This link stops working at ${clockTime(view.expires_at)} ${dayWord(view.expires_at)}.`
              : 'No expiry time is recorded for this link.'}
          </p>
          <p className="mt-1">
            {view.viewed_at
              ? `It was first opened at ${clockTime(view.viewed_at)} ${dayWord(view.viewed_at)}.`
              : 'No earlier opening is recorded for this link.'}
          </p>
        </BelowFold>

        <p className="border-t border-line pt-3 text-[11px] leading-[16px] text-muted-strong">
          Kinvox is a phone line, not an emergency service. Nobody has been sent to this address
          by this record. If this person needs help, call someone — the number above reaches them,
          and their family sent you this link.
        </p>
      </div>
    </main>
  )
}
