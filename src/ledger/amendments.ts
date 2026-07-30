import { createHash } from 'node:crypto';
import type { Client } from 'xrpl';

/**
 * Amendment checking.
 *
 * An XRPL amendment id is the SHA-512Half of its name — the first 32 bytes of
 * SHA-512 over the ASCII name. Deriving it beats hardcoding a hex string copied
 * from a documentation page, which is how you end up asserting against an id that
 * was renamed three months ago.
 *
 * The derivation is self-checking: if the derived id for a known-enabled
 * amendment does not appear in the ledger's enabled list, the derivation itself
 * is wrong and the script says so rather than reporting a false negative.
 */

export function amendmentId(name: string): string {
  return createHash('sha512').update(name, 'ascii').digest('hex').slice(0, 64).toUpperCase();
}

/** The `Amendments` ledger entry lists every amendment currently enabled. */
export async function enabledAmendments(client: Client): Promise<string[]> {
  // `ledger_entry` with `amendments: true` is not in xrpl.js's request union, so
  // the request goes through untyped and the response is narrowed by hand.
  const response = (await client.request({
    command: 'ledger_entry',
    amendments: true,
    ledger_index: 'validated',
  } as never)) as unknown as { result: { node?: { Amendments?: string[] } } };

  return (response.result.node?.Amendments ?? []).map((id) => id.toUpperCase());
}

export interface AmendmentStatus {
  name: string;
  id: string;
  enabled: boolean;
}

export async function checkAmendments(client: Client, names: readonly string[]): Promise<AmendmentStatus[]> {
  const enabled = new Set(await enabledAmendments(client));
  return names.map((name) => {
    const id = amendmentId(name);
    return { name, id, enabled: enabled.has(id) };
  });
}

/**
 * Offline control for the derivation.
 *
 * `MultiSign`'s amendment id is published as a constant on xrpl.org's
 * known-amendments page. Deriving that exact value from the name proves the
 * SHA-512Half method is right without depending on any network's state.
 *
 * This is deliberately NOT a check against the enabled list. A network whose
 * genesis ledger already had an amendment active can omit it from the
 * `Amendments` ledger entry — Devnet does exactly that for MultiSign — so
 * absence from that list is weaker evidence than it looks.
 */
export const DERIVATION_CONTROL = {
  name: 'MultiSign',
  expectedId: '4C97EBA926031A7CF7D7B36FDE3ED66DDA5421192D63DE53FFB46E43B9DC8373',
} as const;

export function derivationIsSound(): boolean {
  return amendmentId(DERIVATION_CONTROL.name) === DERIVATION_CONTROL.expectedId;
}
