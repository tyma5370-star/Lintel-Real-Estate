interface Props {
  values: number[];
  width?: number;
  height?: number;
}

/**
 * NAV per share over the fund's life.
 *
 * Hand-rolled SVG rather than a charting library: it is one polyline over at most
 * a dozen points, and pulling in a chart dependency to draw it would be more code
 * and more supply chain for no gain.
 *
 * The baseline is 1.0 — par — so a fund below its issue price reads as below the
 * line at a glance, which is the whole reason this is on screen.
 */
export function Sparkline({ values, width = 168, height = 44 }: Props) {
  if (values.length < 2) {
    return <div className="dim tiny" style={{ width, textAlign: 'center', paddingTop: 14 }}>—</div>;
  }

  const min = Math.min(...values, 1);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const pad = 3;

  const x = (i: number) => (i / (values.length - 1)) * (width - pad * 2) + pad;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1]!;
  const first = values[0]!;
  const stroke = last >= first ? 'var(--up)' : 'var(--down)';
  const parY = y(1);

  return (
    <svg width={width} height={height} role="img" aria-label="NAV per share history">
      {/* Par line at 1.0 — the reference a depositor actually cares about. */}
      {parY >= 0 && parY <= height && (
        <line x1={0} y1={parY} x2={width} y2={parY} stroke="var(--line)" strokeDasharray="2 3" strokeWidth={1} />
      )}
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.75} fill={stroke} />
    </svg>
  );
}
