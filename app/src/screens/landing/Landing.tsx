import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ScanLine, PhoneCall, BellRing } from 'lucide-react'
import { Button, Card, Label, QuoteBlock, IntakeMeter, Tag, Wordmark } from '../../ui'
import { AuthSteps } from '../../setup/AuthSteps'
import { useSetupDraft } from '../../setup/store'

/**
 * `/` — wireframe 2a. Marketing hero on the left, the real auth column on the right.
 *
 * Two rules drive what is and is not here:
 *
 *  1. The auth column is not a mock. It renders <AuthSteps>, the same machine
 *     /login renders, so there is one OTP flow in this codebase and not two.
 *  2. DESIGN.md's Earned Serif Rule — Newsreader is care content only. On this
 *     page it appears exactly twice: the wordmark, and the one verbatim quote in
 *     "For families". The hero headline is Plex Sans, deliberately.
 *
 * Copy is lifted from frame 2a and PRD §15 rather than written fresh; PRODUCT.md
 * forbids placeholder text, so nothing here is a grey bar waiting for words.
 */

const NAV = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#for-families', label: 'For families' },
]

export default function Landing() {
  const { draft } = useSetupDraft()
  // Someone who started signing up and came back should not have to find their
  // way in again. The draft is the only thing that survives a reload pre-session.
  const resumable = Boolean(draft.phone && !draft.scheduleConfirmed)

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <SiteHeader />

      {resumable && (
        <Link
          to="/login"
          className="border-b border-line bg-accent-soft px-6 py-2 text-center text-sm font-medium text-accent transition-colors hover:bg-accent-soft/70"
        >
          Continue where you left off &rarr;
        </Link>
      )}

      <Hero />
      <HowItWorks />
      <ForFamilies />
      <Pricing />
      <SiteFooter />
    </div>
  )
}

/* ------------------------------------------------------------------- chrome */

function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-canvas/90 px-5 backdrop-blur-sm sm:px-8">
      <Wordmark size={20} />
      <nav className="ml-6 hidden items-center gap-6 md:flex">
        {NAV.map((n) => (
          <a
            key={n.href}
            href={n.href}
            className="text-sm text-muted-strong transition-colors hover:text-ink"
          >
            {n.label}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" href="/login" className="hidden min-h-[36px] px-4 text-sm whitespace-nowrap sm:inline-flex">
          Log in
        </Button>
        {/* was: href="#get-started" — scrolled to the inline auth column below.
            Now opens the split-screen signup page. Old line kept for rollback:
            <Button variant="accent" href="#get-started" className="min-h-[36px] px-4 text-sm whitespace-nowrap">Get started</Button> */}
        <Button variant="accent" href="/signup" className="min-h-[36px] px-4 text-sm whitespace-nowrap">
          Get started
        </Button>
      </div>
    </header>
  )
}

function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line px-5 py-8 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3">
        <Wordmark size={17} />
        <span className="text-sm text-muted-strong">
          The care line that already knows.
        </span>
        <span className="ml-auto text-xs text-muted-strong">
          Built at The Hive Hackathon by ApplyBee AI
        </span>
      </div>
    </footer>
  )
}

/* --------------------------------------------------------------------- hero */

function Hero() {
  return (
    <div
      id="get-started"
      className="flex scroll-mt-[52px] flex-col border-b border-line lg:flex-row lg:items-stretch"
    >
      {/* left — the pitch */}
      <div className="flex flex-1 flex-col gap-4 px-5 py-10 sm:px-8 lg:border-r lg:border-line lg:px-10 lg:py-11">
        <Tag outline className="self-start">
          for adult children of ageing parents
        </Tag>

        {/* Plex Sans, not Newsreader — DESIGN.md:247, the serif is care content only. */}
        <h1 className="max-w-[15ch] text-3xl leading-[1.12] font-bold tracking-[-0.02em] text-balance lg:text-4xl">
          Keep an eye on your parent&rsquo;s medicines
        </h1>
        <p className="max-w-[46ch] text-md text-muted-strong">
          Without calling five times a day. We call them on schedule, and pick up when they
          call in. You only hear what matters.
        </p>

        <div className="mt-1 flex flex-wrap gap-2.5">
          <Button variant="accent" href="/signup">
            Start free
          </Button>
          <Button variant="outline" href="#how-it-works">
            See how it works
          </Button>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <ValueCard icon={<ScanLine size={18} />} title="Scan the prescription">
            We read dose, timing and food rules.
          </ValueCard>
          <ValueCard icon={<PhoneCall size={18} />} title="Agent calls your parent">
            In their language, in your window.
          </ValueCard>
          <ValueCard icon={<BellRing size={18} />} title="You only hear what matters">
            Missed dose, no answer, anything she says that needs you.
          </ValueCard>
        </div>

        <p className="mt-2 max-w-[52ch] text-sm text-muted-strong">
          Your parent installs nothing. Ever. Their entire interface is answering a phone call.
        </p>

        {/* Frame 2a puts a product shot here. This is a real capture of /home, not a
            mockup — PRODUCT.md:42 forbids placeholders. */}
        <figure className="mt-auto overflow-hidden rounded-xl border border-line-strong shadow-card">
          <img
            src="/home-preview.png"
            width={1440}
            height={900}
            alt="The caregiver app: an open P1 alert citing the rule that fired, the next dose, and everything that happened today."
            className="block w-full"
          />
        </figure>
      </div>

      {/* right — the real auth column, 376px as drawn */}
      <div className="flex w-full flex-col gap-3 bg-surface px-5 py-10 sm:px-8 lg:w-[376px] lg:shrink-0 lg:px-[34px] lg:py-11">
        <div className="text-lg font-bold">Create your account</div>
        <p className="text-sm text-muted-strong">One account, one parent to start.</p>
        <div className="h-1" />
        <AuthSteps variant="inset" />
      </div>
    </div>
  )
}

function ValueCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <Card className="gap-1.5">
      <span className="text-accent" aria-hidden="true">
        {icon}
      </span>
      <div className="text-base font-semibold">{title}</div>
      <div className="text-sm text-muted-strong">{children}</div>
    </Card>
  )
}

/* ------------------------------------------------------------ how it works */

function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id: string
  eyebrow: string
  title: string
  lede?: string
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-[52px] border-b border-line px-5 py-12 sm:px-8 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label>{eyebrow}</Label>
          <h2 className="max-w-[22ch] text-2xl leading-tight font-bold tracking-[-0.015em] text-balance">
            {title}
          </h2>
          {lede && <p className="max-w-[62ch] text-md text-muted-strong">{lede}</p>}
        </div>
        {children}
      </div>
    </section>
  )
}

function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title="The inbound call already knows what the outbound calls learned."
      lede="Every other line in this category is one-directional and starts cold. Ours calls out on a schedule to confirm each dose, and everything it learned is already there when your parent calls in."
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:gap-10">
        <div className="flex flex-col gap-4">
          <IntakeMeter known={6} asked={5} />
          <p className="max-w-[46ch] text-md font-semibold">
            Six of twelve are inherited, not asked &mdash; of a frightened caller, at 2 AM.
          </p>
          <p className="max-w-[52ch] text-sm text-muted-strong">
            A line meeting your mother for the first time asks all twelve. Name, age,
            conditions, allergies, medicines, doctor &mdash; the things we already hold. She
            answers only what is genuinely new.
          </p>
        </div>

        <ol className="flex flex-col gap-3">
          <Beat n={1} title="It calls, and confirms the dose">
            At the dose time plus your offset, only if the dose is still unconfirmed. Marking
            it taken yourself cancels the call.
          </Beat>
          <Beat n={2} title="It writes down what she said, word for word">
            No mood score, no percentage. A number nobody can trace back to a sentence is not
            evidence.
          </Beat>
          <Beat n={3} title="It escalates with the rule, not a diagnosis">
            <code className="text-xs">rule: chest complaint with age over 40</code> &mdash;
            never &ldquo;cardiac&rdquo;.
          </Beat>
          <Beat n={4} title="It hands off to whoever is actually there">
            A read-only link, no login, for the neighbour or the clinic desk.
          </Beat>
        </ol>
      </div>
    </Section>
  )
}

function Beat({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <Tag outline className="mt-0.5 h-fit shrink-0">
        {n}
      </Tag>
      <div className="flex flex-col gap-0.5">
        <div className="text-base font-semibold">{title}</div>
        <div className="text-sm text-muted-strong">{children}</div>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------ for families */

function ForFamilies() {
  return (
    <Section
      id="for-families"
      eyebrow="For families"
      title="Capture, never interpret."
      lede="No diagnosis, no dosing guidance, no symptom interpretation, and never a claim that help has been dispatched. Every transcript is scored against those rules; a violation is a failed run, not a warning."
    >
      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:gap-10">
        {/* The page's one serif, and the only place it is earned. */}
        <QuoteBlock
          severity="red"
          lang="hi"
          attribution={
            <>
              <Tag tone="danger">red</Tag>
              <span>Mom &middot; check-in call #214 &middot; 1:35 PM</span>
            </>
          }
        >
          छाती में जकड़न होती है जब मैं चलती हूँ।
        </QuoteBlock>

        <Card emphasis="rule" className="h-fit gap-2.5">
          <Label>Why this was flagged</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone="danger">P1</Tag>
            <code className="text-sm">rule: chest complaint with age over 40</code>
          </div>
          <p className="text-sm text-muted-strong">
            Triggered on the words she used. No interpretation, no diagnosis. You see the rule
            that fired and the sentence underneath it, so you can disagree with both.
          </p>
        </Card>
      </div>
    </Section>
  )
}

/* ---------------------------------------------------------------- pricing */

const TIERS = [
  {
    name: 'Trial',
    price: 'Free',
    unit: 'for 7 days',
    includes: ['1 dose slot a day', 'Inbound line'],
    cta: 'Start free',
    featured: false,
  },
  {
    name: 'Care',
    price: '₹499',
    unit: 'per month',
    includes: [
      'Up to 2 dose slots a day',
      'Inbound line',
      'Caregiver app',
      'Escalations to your family',
    ],
    cta: 'Choose Care',
    featured: true,
  },
  {
    name: 'Care+',
    price: '₹999',
    unit: 'per month',
    includes: ['Unlimited dose slots', 'Priority-medicine alerts', 'Read-only handoff links'],
    cta: 'Choose Care+',
    featured: false,
  },
]

function Pricing() {
  return (
    <Section
      id="pricing"
      eyebrow="Pricing"
      title="Priced below the Indian consumer benchmark."
      lede="Billed on adherence, not on minutes. The closest comparable product is ₹1,499 a month and needs your parent to own and use a smartphone."
    >
      <div className="grid gap-3 md:grid-cols-3">
        {TIERS.map((t) => (
          <Card
            key={t.name}
            emphasis={t.featured ? 'border' : 'none'}
            className="gap-3 p-4"
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold">{t.name}</span>
              {t.featured && <Tag tone="accent">most families</Tag>}
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="tnum text-2xl font-bold tracking-[-0.02em]">{t.price}</span>
              <span className="text-sm text-muted-strong">{t.unit}</span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {t.includes.map((line) => (
                <li key={line} className="flex gap-2 text-sm text-muted-strong">
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />
                  {line}
                </li>
              ))}
            </ul>
            <Button
              variant={t.featured ? 'accent' : 'outline'}
              href="/signup"
              className="mt-auto w-full"
            >
              {t.cta}
            </Button>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-strong">
        Paid plans start after the trial. UPI checkout is not connected yet &mdash; choosing a
        plan takes you to sign-up.
      </p>
    </Section>
  )
}
