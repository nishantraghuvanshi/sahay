// Hand-drawn-style line art — botanicals and medicine objects — that sits
// behind the whole hero. Built from small primitives rather than one giant
// path so density is a matter of placement, not of redrawing shapes.

type Placed = { x: number; y: number; rotate?: number; scale?: number }

function Leaf({ x, y, rotate = 0, scale = 1, veins = true }: Placed & { veins?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <path d="M0 0 C 34 -6, 58 -30, 60 -62 C 26 -58, 2 -34, 0 0 Z" />
      {veins && (
        <>
          <path d="M4 -6 C 22 -20, 38 -36, 52 -54" opacity="0.55" />
          <path d="M14 -10 L 24 -26" opacity="0.4" />
          <path d="M30 -20 L 38 -36" opacity="0.4" />
        </>
      )}
    </g>
  )
}

function Sprig({ x, y, rotate = 0, scale = 1 }: Placed) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <path d="M0 0 C 14 -60, -6 -110, 16 -170 C 32 -214, 26 -252, 44 -292" />
      <Leaf x={6} y={-34} rotate={-14} scale={0.52} />
      <Leaf x={4} y={-72} rotate={166} scale={0.46} />
      <Leaf x={16} y={-124} rotate={-22} scale={0.58} />
      <Leaf x={14} y={-176} rotate={158} scale={0.44} />
      <Leaf x={30} y={-224} rotate={-30} scale={0.5} />
    </g>
  )
}

function Capsule({ x, y, rotate = 0, scale = 1 }: Placed) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <rect x="0" y="0" width="112" height="48" rx="24" />
      <line x1="56" y1="2" x2="56" y2="46" />
      <path d="M20 24 h16" opacity="0.5" />
      <path d="M74 17 h20 M74 31 h13" opacity="0.5" />
    </g>
  )
}

function Tablet({ x, y, scale = 1, scored = 'cross' }: Placed & { scored?: 'cross' | 'line' | 'ring' }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <circle cx="0" cy="0" r="28" />
      {scored === 'cross' && (
        <path d="M-20 0 h40 M0 -20 v40" opacity="0.55" />
      )}
      {scored === 'line' && <path d="M-20 0 h40" opacity="0.55" />}
      {scored === 'ring' && <circle cx="0" cy="0" r="15" opacity="0.5" />}
    </g>
  )
}

function Blister({ x, y, rotate = 0, scale = 1 }: Placed) {
  const cells = [0, 1, 2, 3].flatMap((col) =>
    [0, 1].map((row) => (
      <ellipse
        key={`${col}-${row}`}
        cx={22 + col * 30}
        cy={20 + row * 32}
        rx="11"
        ry="13"
        opacity="0.6"
      />
    )),
  )
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <rect x="0" y="0" width="134" height="72" rx="12" />
      {cells}
    </g>
  )
}

function Bottle({ x, y, rotate = 0, scale = 1 }: Placed) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <rect x="14" y="0" width="44" height="18" rx="4" />
      <path d="M8 18 h56 a10 10 0 0 1 10 10 v72 a10 10 0 0 1 -10 10 h-56 a10 10 0 0 1 -10 -10 v-72 a10 10 0 0 1 10 -10 z" />
      <rect x="10" y="42" width="52" height="34" rx="5" opacity="0.55" />
      <path d="M20 54 h32 M20 64 h22" opacity="0.4" />
    </g>
  )
}

function Pulse({ x, y, scale = 1 }: Placed) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path d="M0 0 h34 l12 -26 l16 54 l14 -34 l10 12 h38" />
    </g>
  )
}

function Seeds({ x, y, scale = 1 }: Placed) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} opacity="0.7">
      <circle cx="0" cy="0" r="4" />
      <circle cx="20" cy="12" r="3" />
      <circle cx="8" cy="26" r="3.5" />
      <circle cx="30" cy="-8" r="2.5" />
    </g>
  )
}

export default function SketchBackdrop() {
  return (
    <svg
      className="hero__sketch"
      viewBox="0 0 1440 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* ── Left cluster: the densest corner, opposite the copy ───────── */}
      <g className="hero__sketch-group">
        <Sprig x={64} y={742} rotate={-4} scale={1.05} />
        <Sprig x={214} y={790} rotate={9} scale={0.78} />
        <Sprig x={-16} y={470} rotate={-16} scale={0.62} />
        <Leaf x={168} y={252} rotate={38} scale={0.9} />
        <Leaf x={44} y={196} rotate={-64} scale={0.7} />
        <Capsule x={196} y={96} rotate={26} scale={1} />
        <Capsule x={36} y={318} rotate={-14} scale={0.72} />
        <Tablet x={318} y={214} scale={1} scored="cross" />
        <Tablet x={252} y={318} scale={0.62} scored="ring" />
        <Tablet x={122} y={402} scale={0.8} scored="line" />
        <Blister x={228} y={470} rotate={-11} scale={0.86} />
        <Bottle x={352} y={392} rotate={7} scale={0.82} />
        <Seeds x={300} y={130} scale={1.1} />
        <Pulse x={92} y={604} scale={0.9} />
      </g>

      {/* ── Top band: carries the art across the full width ───────────── */}
      <g className="hero__sketch-group">
        <Leaf x={470} y={104} rotate={128} scale={0.72} />
        <Capsule x={556} y={196} rotate={-38} scale={0.62} />
        <Tablet x={432} y={276} scale={0.56} scored="cross" />
        <Seeds x={520} y={54} scale={0.9} />
        <Leaf x={640} y={44} rotate={-108} scale={0.6} />
        <Tablet x={716} y={128} scale={0.46} scored="ring" />
        <Capsule x={848} y={40} rotate={16} scale={0.54} />
        <Leaf x={1010} y={130} rotate={148} scale={0.66} />
        <Seeds x={950} y={82} scale={0.8} />
        <Tablet x={1128} y={62} scale={0.6} scored="line" />
        <Capsule x={1188} y={158} rotate={-28} scale={0.7} />
        <Pulse x={880} y={128} scale={0.6} />
      </g>

      {/* ── Right cluster: balances the left, frames the waitlist card ── */}
      <g className="hero__sketch-group">
        <Sprig x={1392} y={782} rotate={12} scale={0.94} />
        <Sprig x={1254} y={818} rotate={-8} scale={0.7} />
        <Leaf x={1330} y={340} rotate={-48} scale={0.86} />
        <Leaf x={1246} y={432} rotate={64} scale={0.62} />
        <Capsule x={1268} y={556} rotate={34} scale={0.8} />
        <Tablet x={1390} y={492} scale={0.74} scored="cross" />
        <Blister x={1290} y={646} rotate={8} scale={0.7} />
        <Bottle x={1160} y={598} rotate={-6} scale={0.66} />
        <Seeds x={1216} y={300} scale={1} />
      </g>

      {/* ── Lower band: keeps the fade-out edge from feeling empty ────── */}
      <g className="hero__sketch-group">
        <Tablet x={512} y={706} scale={0.66} scored="ring" />
        <Capsule x={598} y={716} rotate={-18} scale={0.6} />
        <Leaf x={772} y={772} rotate={-136} scale={0.7} />
        <Seeds x={880} y={716} scale={0.9} />
        <Tablet x={968} y={758} scale={0.52} scored="line" />
        <Pulse x={620} y={630} scale={0.7} />
        <Leaf x={430} y={620} rotate={92} scale={0.54} />
      </g>
    </svg>
  )
}
