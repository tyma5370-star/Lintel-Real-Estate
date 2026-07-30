/** Display formatting. Presentation only — no arithmetic that affects a decision. */

export const money = (value: number, dp = 2): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const money0 = (value: number): string => money(value, 0);

export const pct = (fraction: number, dp = 1): string => `${(fraction * 100).toFixed(dp)}%`;

export const ratio = (value: number, dp = 2): string =>
  Number.isFinite(value) ? `${value.toFixed(dp)}x` : '—';

export const nav = (value: number): string => value.toFixed(6);

/** Rates arrive from the ledger in 1/10 basis points. 9500 -> "9.500%". */
export const tenthBps = (value: number): string => `${(value / 1000).toFixed(3)}%`;

export const shortId = (id: string, chars = 8): string =>
  id.length <= chars * 2 ? id : `${id.slice(0, chars)}…${id.slice(-4)}`;

/**
 * Seconds rendered at human scale. On-chain payment intervals are real months
 * (2,629,800s), so rendering them in seconds alone would look like a bug.
 */
export function duration(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h`;
  const days = seconds / 86_400;
  if (days < 45) return `${days.toFixed(1)} days`;
  return `${(days / 30.4375).toFixed(1)} months`;
}

export const gradeClass = (grade: string): string => grade.toLowerCase();
