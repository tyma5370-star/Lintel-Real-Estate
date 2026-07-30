import { useState } from 'react';

export interface SparkPoint {
  value: number;
  note: string;
}

interface Props {
  points: SparkPoint[];
  width?: number;
  height?: number;
}

/**
 * NAV per share over the fund's life.
 *
 * Hand-rolled SVG rather than a charting library: one polyline over a handful of
 * points. A chart dependency to draw this would be more code and more supply
 * chain for no gain.
 *
 * Design notes, per the visualization rules this project follows:
 *  - Single series, so no legend — the label beside it names the measure.
 *  - 2px stroke, 8px end marker, recessive dashed baseline.
 *  - The baseline is par (1.0), because "is the fund above or below what
 *    depositors paid" is the actual question a NAV line answers.
 *  - It has a plot, so it gets a hover layer: nearest-point crosshair with a
 *    tooltip naming the value and the event that caused it.
 */
export function Sparkline({ points, width = 176, height = 48 }: Props) {
  const [active, setActive] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div className="dim tiny" style={{ width, textAlign: 'center', paddingTop: 16 }}>
        —
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values, 1);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const pad = 5;

  const x = (i: number) => (i / (points.length - 1)) * (width - pad * 2) + pad;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const stroke = last >= first ? 'var(--good)' : 'var(--critical)';
  const parY = y(1);

  // Nearest point to the pointer, so the hit target is far bigger than the mark.
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    let nearest = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(i) - px) < Math.abs(x(nearest) - px)) nearest = i;
    }
    setActive(nearest);
  };

  const hovered = active === null ? null : points[active]!;

  return (
    <div className="spark" style={{ width, height }}>
      {hovered && (
        <div className="spark-tip" style={{ left: x(active!), top: y(hovered.value) - 8 }}>
          <div className="n">{hovered.value.toFixed(6)}</div>
          <div className="e">{hovered.note}</div>
        </div>
      )}
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`NAV per share, ${points.length} points, currently ${last.toFixed(6)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setActive(null)}
      >
        {/* Par (1.0) — recessive reference line. */}
        {parY >= 0 && parY <= height && (
          <line
            x1={0}
            y1={parY}
            x2={width}
            y2={parY}
            stroke="var(--border-strong)"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
        )}

        <polyline
          points={path}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {active !== null && (
          <line
            x1={x(active)}
            y1={0}
            x2={x(active)}
            y2={height}
            stroke="var(--border-strong)"
            strokeWidth={1}
          />
        )}

        {/* End marker, and the hovered point. 8px diameter. */}
        <circle cx={x(points.length - 1)} cy={y(last)} r={4} fill={stroke} stroke="var(--surface)" strokeWidth={2} />
        {active !== null && active !== points.length - 1 && (
          <circle
            cx={x(active)}
            cy={y(points[active]!.value)}
            r={4}
            fill={stroke}
            stroke="var(--surface)"
            strokeWidth={2}
          />
        )}
      </svg>
    </div>
  );
}
