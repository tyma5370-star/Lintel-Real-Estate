import type { Client } from 'xrpl';
import { getVault, mptBalance, type VaultView } from './read';

/**
 * NAV per share.
 *
 * The protocol does not expose this. It has to be reconstructed client-side from
 * `AssetsTotal`, `LossUnrealized`, and the share MPT's outstanding supply:
 *
 *     navPerShare = (AssetsTotal - LossUnrealized) / sharesOutstanding
 *
 * This is the number that proves the vault accounting is real. It rises when
 * interest is paid into the vault and falls when a default writes down assets,
 * and it does so without anybody telling it to.
 */

export interface Nav {
  assetsTotal: number;
  assetsAvailable: number;
  lossUnrealized: number;
  /** Assets net of unrealized loss — the fund's current value. */
  netAssets: number;
  sharesOutstanding: bigint;
  /** Shares expressed in whole units, using the vault's Scale. */
  sharesOutstandingScaled: number;
  /** Net asset value per whole share. */
  navPerShare: number;
  /**
   * Redemption rate: what a share is worth on the way out, i.e. NAV per share.
   * Reflects unrealized losses.
   */
  redemptionRatePerShare: number;
  /**
   * Deposit rate: what a share costs on the way in. The protocol prices deposits
   * so a new depositor does not buy into a loss they were not present for, which
   * means it uses gross assets rather than net.
   *
   * Both rates are computed here because neither is directly queryable — a
   * client cannot ask the ledger what a share currently costs or is worth.
   */
  depositRatePerShare: number;
  scale: number;
}

export function computeNav(vault: VaultView): Nav {
  const scaleFactor = 10 ** vault.scale;
  const sharesScaled = Number(vault.sharesOutstanding) / scaleFactor;
  const netAssets = vault.assetsTotal - vault.lossUnrealized;

  const navPerShare = sharesScaled > 0 ? netAssets / sharesScaled : 1;
  const depositRatePerShare = sharesScaled > 0 ? vault.assetsTotal / sharesScaled : 1;

  return {
    assetsTotal: vault.assetsTotal,
    assetsAvailable: vault.assetsAvailable,
    lossUnrealized: vault.lossUnrealized,
    netAssets,
    sharesOutstanding: vault.sharesOutstanding,
    sharesOutstandingScaled: sharesScaled,
    navPerShare,
    redemptionRatePerShare: navPerShare,
    depositRatePerShare,
    scale: vault.scale,
  };
}

export async function readNav(client: Client, vaultId: string): Promise<Nav> {
  return computeNav(await getVault(client, vaultId));
}

export interface LpPosition {
  address: string;
  shares: bigint;
  sharesScaled: number;
  /** Current redemption value of the position. */
  value: number;
  /** Share of the fund, 0–1. */
  ownership: number;
}

export async function readPosition(
  client: Client,
  address: string,
  vaultId: string,
  nav?: Nav,
): Promise<LpPosition> {
  const vault = await getVault(client, vaultId);
  const resolved = nav ?? computeNav(vault);
  const held = await mptBalance(client, address, vault.shareMptId);
  const sharesScaled = Number(held) / 10 ** vault.scale;

  return {
    address,
    shares: held,
    sharesScaled,
    value: sharesScaled * resolved.navPerShare,
    ownership: resolved.sharesOutstandingScaled > 0 ? sharesScaled / resolved.sharesOutstandingScaled : 0,
  };
}
