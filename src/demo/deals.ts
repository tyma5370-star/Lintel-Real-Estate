import type { DealInput } from '../underwriting/types';

/**
 * The three demo deals.
 *
 * Chosen as archetypes rather than as numbers that happen to work: a stabilised
 * cash-flowing rental, a value-add reposition, and a deal that should not be
 * financed. All three are run through the same engine with the same policy — none
 * of the outcomes is hardcoded, and changing a single input changes the result.
 *
 *   Cleveland — grade B, approved, repays on schedule
 *   Pueblo    — grade D, DECLINED, shows the binding constraint
 *   Boulder   — grade C, approved, impaired then defaulted
 */

/** Stabilised single-family rental. Modest ARV, strong coverage, repeat sponsor. */
export const CLEVELAND: DealInput = {
  id: 'CLE-001',
  address: '3412 W 46th St, Cleveland, OH 44102',
  purchasePrice: 120_000,
  rehabBudget: 30_000,
  afterRepairValue: 210_000,
  asIsValue: 130_000,
  monthlyGrossRent: 2_100,
  vacancyRate: 0.07,
  monthlyTaxes: 250,
  monthlyInsurance: 95,
  monthlyHOA: 0,
  maintenanceReserveRate: 0.05,
  managementFeeRate: 0.08,
  termMonths: 12,
  exitStrategy: 'refinance',
  sponsorLiquidity: 60_000,
  sponsorPriorDeals: 6,
};

/**
 * Duplex with thin exit coverage and a first-time sponsor.
 *
 * This one is meant to fail. An engine that approves everything is not an engine,
 * and a decline with its binding constraint stated is more convincing than a third
 * approval.
 */
export const PUEBLO: DealInput = {
  id: 'PUE-002',
  address: '1120 E Evans Ave, Pueblo, CO 81004',
  purchasePrice: 185_000,
  rehabBudget: 65_000,
  afterRepairValue: 268_000,
  asIsValue: 195_000,
  monthlyGrossRent: 1_750,
  vacancyRate: 0.1,
  monthlyTaxes: 210,
  monthlyInsurance: 130,
  monthlyHOA: 0,
  maintenanceReserveRate: 0.06,
  managementFeeRate: 0.08,
  termMonths: 12,
  exitStrategy: 'sale',
  sponsorLiquidity: 8_000,
  sponsorPriorDeals: 0,
};

/** Value-add reposition. High ARV, coverage is the binding constraint. */
export const BOULDER: DealInput = {
  id: 'BLD-003',
  address: '2245 Bluff St, Boulder, CO 80304',
  purchasePrice: 520_000,
  rehabBudget: 180_000,
  afterRepairValue: 1_050_000,
  asIsValue: 560_000,
  monthlyGrossRent: 8_200,
  vacancyRate: 0.08,
  monthlyTaxes: 700,
  monthlyInsurance: 260,
  monthlyHOA: 180,
  maintenanceReserveRate: 0.05,
  managementFeeRate: 0.07,
  termMonths: 12,
  exitStrategy: 'sale',
  sponsorLiquidity: 55_000,
  sponsorPriorDeals: 2,
};

export const DEMO_DEALS: DealInput[] = [CLEVELAND, PUEBLO, BOULDER];

/** Narration for each deal, printed by the demo before it is underwritten. */
export const DEAL_NARRATIVE: Record<string, string> = {
  'CLE-001':
    'A repeat sponsor buying a tired single-family rental at $120k with a $30k scope of work, ' +
    'refinancing into agency debt at $210k. Rents are already market. This is core bridge.',
  'PUE-002':
    'A first-time sponsor on a duplex at $185k plus $65k of work, exiting by sale at $268k. ' +
    'The spread is thin and there is no track record behind it.',
  'BLD-003':
    'A value-add reposition: $520k purchase, $180k of work, $1.05m after repair. ' +
    'Strong exit value, but the stabilised income is what limits leverage here.',
};
