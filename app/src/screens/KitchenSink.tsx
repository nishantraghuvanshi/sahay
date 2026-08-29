import {
  Bar,
  Button,
  Card,
  Chip,
  Divider,
  DoseStatusChip,
  Dot,
  EmptyBlock,
  ErrorBlock,
  Field,
  Label,
  LoadingBlock,
  Placeholder,
  Row,
  SeverityChip,
  Tag,
} from '../ui'
import { useCareRecord, useDaySummary, useDoseHistory, useEscalations, useObservations } from '../api/hooks'
import { ApiError } from '../api/client'

/**
 * Dev-only review surface: every primitive in every state, plus a live read of the
 * mock so the fixture can be checked against TRD §3.2 without opening a real screen.
 */
export default function KitchenSink() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[18px] font-bold">Kitchen sink</h1>
        <p className="text-[11px] text-muted-strong">
          Primitives ported from the wireframe atoms. Compare side by side with{' '}
          <code>wireframe/*.dc.html</code>. Try <code>?fail=doses</code> and <code>?empty=1</code>.
        </p>
      </header>

      <Section title="Buttons">
        <Row className="flex-wrap">
          <Button>Mark taken</Button>
          <Button variant="outline">Call Mom</Button>
          <Button disabled>Continue on the app</Button>
          <Button variant="outline" disabled>
            Save and Continue
          </Button>
        </Row>
      </Section>

      <Section title="Chips and tags">
        <Row className="flex-wrap">
          <Chip on>Day</Chip>
          <Chip>Month</Chip>
          <Chip>Year</Chip>
          <Chip>All time</Chip>
          <Tag>P1</Tag>
          <Tag outline>watch</Tag>
          <Tag>red</Tag>
        </Row>
      </Section>

      <Section title="Dose status — four states, never colour alone">
        <Row className="flex-wrap gap-4">
          <DoseStatusChip status="confirmed" />
          <DoseStatusChip status="deferred" />
          <DoseStatusChip status="missed" />
          <DoseStatusChip status="no_answer" />
        </Row>
        <Row className="flex-wrap gap-4">
          <SeverityChip severity="none" />
          <SeverityChip severity="watch" />
          <SeverityChip severity="red" />
        </Row>
        <Row className="gap-3">
          <Dot kind="filled" /> <Dot kind="hollow" /> <Dot kind="empty" />
        </Row>
      </Section>

      <Section title="Cards">
        <Card>
          <Label>Plain</Label>
          <div className="text-[12px]">Default surface card.</div>
        </Card>
        <Card emphasis="border">
          <Label>Emphasis: border</Label>
          <div className="text-[12px]">The one thing on screen that matters most.</div>
        </Card>
        <Card emphasis="rule">
          <Label>Emphasis: left rule</Label>
          <div className="text-[12px]">Needs attention, but is not the headline.</div>
        </Card>
      </Section>

      <Section title="Fields, bars, placeholder">
        <Field value="+91 98765 43210" />
        <Field placeholder="rohit@gmail.com" />
        <Bar width="80%" />
        <Bar width="200px" fill={0.42} />
        <Placeholder className="h-24">scanned page preview</Placeholder>
      </Section>

      <Section title="Page states">
        <LoadingBlock />
        <Divider />
        <ErrorBlock error={new ApiError('Cannot reach the Care API.', 'unreachable')} onRetry={() => {}} />
        <EmptyBlock
          title="No medicines yet"
          body="Add a prescription and we build the schedule from it."
          action={<Button>Add prescription</Button>}
        />
      </Section>

      <Section title="Live read of the mock">
        <MockReadout />
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <Label>{title}</Label>
      {children}
    </section>
  )
}

function MockReadout() {
  const record = useCareRecord()
  const doses = useDoseHistory()
  const observations = useObservations()
  const escalations = useEscalations()
  const summary = useDaySummary()

  if (record.isLoading) return <LoadingBlock rows={4} />
  if (record.error) return <ErrorBlock error={record.error} onRetry={() => record.refetch()} />

  const p = record.data!.patient
  return (
    <Card>
      <Row>
        <span className="text-[13px] font-bold">
          {p.name}
          {p.honorific ? `-${p.honorific}` : ''} · {p.age}
        </span>
        <Tag outline>{p.language}</Tag>
        {p.schedule_signed_off_at ? <Tag>signed off</Tag> : <Tag>not signed off</Tag>}
      </Row>
      <div className="text-[11px] text-muted-strong">
        {p.conditions.join(' · ')} — allergies: {p.allergies.join(', ') || 'none recorded'}
      </div>
      <Divider />
      <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
        <Stat label="medicines" value={record.data!.medications.length} />
        <Stat label="dose events" value={doses.data?.length ?? '…'} />
        <Stat label="observations" value={observations.data?.length ?? '…'} />
        <Stat label="escalations" value={escalations.data?.length ?? '…'} />
        <Stat
          label="doses today"
          value={summary.data ? `${summary.data.doses_confirmed}/${summary.data.doses_total}` : '…'}
        />
        <Stat label="summary items" value={summary.data?.items.length ?? '…'} />
      </div>
      {escalations.data?.[0] && (
        <>
          <Divider />
          <Label>Escalation reason, rendered literally</Label>
          <div className="text-[12px] font-semibold">{escalations.data[0].reason}</div>
        </>
      )}
      {observations.data?.[0] && (
        <>
          <Label>Newest observation, verbatim</Label>
          <div className="text-[12px]">“{observations.data[0].text}”</div>
        </>
      )}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-line bg-paper px-2 py-1.5">
      <div className="text-[15px] font-bold">{value}</div>
      <Label>{label}</Label>
    </div>
  )
}
