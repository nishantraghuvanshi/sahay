import { useLocation } from 'react-router-dom'

/**
 * Scaffold-only. Every route resolves to something rather than a blank page,
 * so the route map is verifiable before any screen has content.
 * Each real screen replaces its Placeholder in a later phase.
 */
export default function Placeholder({ title, frame }: { title: string; frame: string }) {
  const { pathname } = useLocation()

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h1 className="text-[17px] font-bold">{title}</h1>
        <span className="rounded border border-ink px-1.5 py-0.5 text-[9px] font-bold">{frame}</span>
      </div>
      <div className="rounded-lg border border-line-strong bg-surface p-4">
        <div className="text-[11px] tracking-wider text-muted uppercase">route</div>
        <div className="font-mono text-[12px]">{pathname}</div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-2 w-4/5 rounded bg-fill" />
        <div className="h-2 w-3/5 rounded bg-fill" />
        <div className="h-2 w-2/5 rounded bg-fill" />
      </div>
      <p className="text-[11px] text-muted-strong">
        Scaffold placeholder — no data is wired yet.
      </p>
    </section>
  )
}
