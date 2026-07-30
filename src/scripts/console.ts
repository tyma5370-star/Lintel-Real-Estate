/**
 * Console narration.
 *
 * A judge reading only the console output should be able to understand the
 * product, so every step prints what is happening in *fund* terms first and
 * protocol terms second.
 */

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREY = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (colour: string, text: string) => (useColour ? `${colour}${text}${RESET}` : text);

export const heading = (text: string): void => {
  console.log('');
  console.log(paint(BOLD + CYAN, `── ${text} ${'─'.repeat(Math.max(0, 68 - text.length))}`));
};

export const step = (n: number | string, text: string): void =>
  console.log(paint(BOLD, `\n[${n}] ${text}`));

export const ok = (text: string): void => console.log(`  ${paint(GREEN, '✓')} ${text}`);
export const fail = (text: string): void => console.log(`  ${paint(RED, '✗')} ${text}`);
export const warn = (text: string): void => console.log(`  ${paint(YELLOW, '!')} ${text}`);
export const info = (text: string): void => console.log(`  ${paint(GREY, '·')} ${text}`);
export const note = (text: string): void => console.log(`    ${paint(GREY, text)}`);

/** Print a transaction result with its explorer link — judges click these. */
export const tx = (label: string, hash: string, explorer: string): void => {
  console.log(`  ${paint(GREEN, '✓')} ${label}`);
  console.log(`    ${paint(GREY, hash)}`);
  console.log(`    ${paint(CYAN, explorer)}`);
};

export const money = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const pct = (fraction: number, dp = 1): string => `${(fraction * 100).toFixed(dp)}%`;

/** Two-column key/value block. */
export const table = (rows: Array<[string, string]>, indent = '    '): void => {
  const width = Math.max(...rows.map(([key]) => key.length));
  for (const [key, value] of rows) {
    console.log(`${indent}${paint(GREY, key.padEnd(width))}  ${value}`);
  }
};

export const banner = (text: string): void => {
  const line = '═'.repeat(Math.max(text.length + 4, 40));
  console.log('');
  console.log(paint(BOLD + CYAN, line));
  console.log(paint(BOLD + CYAN, `  ${text}`));
  console.log(paint(BOLD + CYAN, line));
};
