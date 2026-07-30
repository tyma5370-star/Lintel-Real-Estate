import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hash of the underwriting policy source.
 *
 * A prefix of this goes into the vault's on-ledger `Data` field, which commits the
 * fund to a specific version of its credit box. Anyone can clone the repo, hash
 * `policy.ts`, and check it against the vault entry — so "we underwrote to our
 * stated policy" becomes verifiable rather than assertable.
 *
 * Hashing the source file is deliberate: it covers every threshold and every grade
 * row, and it changes the moment any of them changes.
 */
export function policyHash(): string {
  const path = join(__dirname, '..', 'underwriting', 'policy.ts');
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}
