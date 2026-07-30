import { describe, expect, it } from 'vitest';
import { BOULDER, CLEVELAND, PUEBLO } from '../src/demo/deals';
import { underwrite, validate } from '../src/underwriting/engine';
import { incomeMetrics } from '../src/underwriting/metrics';
import { POLICY } from '../src/underwriting/policy';
import { sizeLoan } from '../src/underwriting/size';
import type { DealInput } from '../src/underwriting/types';

describe('incomeMetrics', () => {
  it('computes NOI from a hand-checked Cleveland income statement', () => {
    // EGI  = 2100 x (1 - 0.07) x 12       = 23,436.00
    // fixed= (250 + 95 + 0) x 12          =  4,140.00
    // var  = 23,436 x (0.05 + 0.08)       =  3,046.68
    // NOI  = 23,436 - 7,186.68            = 16,249.32
    const income = incomeMetrics(CLEVELAND);
    expect(income.effectiveGrossIncome).toBeCloseTo(23_436, 2);
    expect(income.operatingExpenses).toBeCloseTo(7_186.68, 2);
    expect(income.netOperatingIncome).toBeCloseTo(16_249.32, 2);
    expect(income.totalProjectCost).toBe(150_000);
  });

  it('does not silently treat a missing HOA as zero', () => {
    // The type requires it; the runtime validator is what catches an API caller.
    const { monthlyHOA, ...rest } = CLEVELAND;
    expect(() => validate(rest as unknown as DealInput)).toThrow(/monthlyHOA/);
  });

  it('charges HOA against NOI rather than ignoring it', () => {
    const withHoa = incomeMetrics({ ...CLEVELAND, monthlyHOA: 200 });
    const without = incomeMetrics(CLEVELAND);
    expect(without.netOperatingIncome - withHoa.netOperatingIncome).toBeCloseTo(2_400, 6);
  });
});

describe('sizeLoan', () => {
  it('takes the minimum across every constraint, never the headline LTV', () => {
    const income = incomeMetrics(CLEVELAND);
    const sizing = sizeLoan(CLEVELAND, income, 9.5);
    const tightest = Math.min(...sizing.constraints.map((c) => c.maxLoan));
    expect(sizing.loanAmount).toBe(Math.floor(tightest));
  });

  it('names the constraint that actually bound', () => {
    const sizing = sizeLoan(CLEVELAND, incomeMetrics(CLEVELAND), 9.5);
    const binding = sizing.constraints.find((c) => c.name === sizing.bindingConstraint)!;
    for (const constraint of sizing.constraints) {
      expect(binding.maxLoan).toBeLessThanOrEqual(constraint.maxLoan + 1e-6);
    }
  });

  it('never sizes up into a constraint — it rounds down', () => {
    const sizing = sizeLoan(CLEVELAND, incomeMetrics(CLEVELAND), 9.5);
    expect(Number.isInteger(sizing.loanAmount)).toBe(true);
    const tightest = Math.min(...sizing.constraints.map((c) => c.maxLoan));
    expect(sizing.loanAmount).toBeLessThanOrEqual(tightest);
  });

  it('measures as-is LTV against the advance at close, not the full commitment', () => {
    // The rehab is a holdback, so a loan may legitimately exceed the as-is value.
    const income = incomeMetrics(CLEVELAND);
    const sizing = sizeLoan(CLEVELAND, income, 9.5);
    const advance = sizing.constraints.find((c) => c.name === 'asIsAdvance')!;
    expect(advance.maxLoan).toBeCloseTo(CLEVELAND.asIsValue * POLICY.maxLtvAsIs + CLEVELAND.rehabBudget, 6);
  });

  it('tightens the DSCR constraint as the rate rises', () => {
    const income = incomeMetrics(CLEVELAND);
    const cheap = sizeLoan(CLEVELAND, income, 8).constraints.find((c) => c.name === 'dscr')!;
    const dear = sizeLoan(CLEVELAND, income, 14).constraints.find((c) => c.name === 'dscr')!;
    expect(dear.maxLoan).toBeLessThan(cheap.maxLoan);
  });
});

describe('the three demo deals', () => {
  it('grades Cleveland B and approves it, bound by LTC', () => {
    const result = underwrite(CLEVELAND);
    expect(result.decision.approved).toBe(true);
    expect(result.decision.grade).toBe('B');
    expect(result.sizing.bindingConstraint).toBe('ltc');
    expect(result.sizing.loanAmount).toBe(127_500);
    expect(result.terms!.annualRatePercent).toBeCloseTo(9.5, 6);
  });

  it('grades Boulder C and approves it, bound by DSCR', () => {
    const result = underwrite(BOULDER);
    expect(result.decision.approved).toBe(true);
    expect(result.decision.grade).toBe('C');
    expect(result.sizing.bindingConstraint).toBe('dscr');
    expect(result.terms!.annualRatePercent).toBeCloseTo(11.5, 6);
  });

  it('declines Pueblo and says which constraint bound', () => {
    const result = underwrite(PUEBLO);
    expect(result.decision.approved).toBe(false);
    expect(result.decision.grade).toBe('D');
    expect(result.terms).toBeUndefined();
    expect(result.decision.declineReasons.length).toBeGreaterThan(0);
    // The decline must be actionable, not just "computer says no".
    expect(result.decision.declineReasons.join(' ')).toMatch(/dscr|DSCR/);
    expect(result.decision.declineReasons.join(' ')).toMatch(/Proceeds inadequate/);
  });

  it('sizes every approved deal within every policy limit', () => {
    for (const deal of [CLEVELAND, BOULDER]) {
      const { metrics } = underwrite(deal);
      expect(metrics.arvLtv).toBeLessThanOrEqual(POLICY.maxArvLtv + 1e-9);
      expect(metrics.ltc).toBeLessThanOrEqual(POLICY.maxLtc + 1e-9);
      expect(metrics.dscr).toBeGreaterThanOrEqual(POLICY.minDscr - 1e-9);
      expect(metrics.debtYield).toBeGreaterThanOrEqual(POLICY.minDebtYield - 1e-9);
      expect(metrics.exitCoverage).toBeGreaterThanOrEqual(POLICY.minExitCoverage - 1e-9);
    }
  });
});

describe('engine behaviour', () => {
  it('converges: re-underwriting the same deal gives the same answer', () => {
    for (const deal of [CLEVELAND, PUEBLO, BOULDER]) {
      expect(underwrite(deal)).toEqual(underwrite(deal));
    }
  });

  it('prices a weaker grade at a higher rate', () => {
    const cleveland = underwrite(CLEVELAND);
    const boulder = underwrite(BOULDER);
    expect(boulder.terms!.annualRatePercent).toBeGreaterThan(cleveland.terms!.annualRatePercent);
  });

  it('requires more first-loss cover for a weaker grade', () => {
    expect(underwrite(BOULDER).terms!.requiredCoverPercent).toBeGreaterThan(
      underwrite(CLEVELAND).terms!.requiredCoverPercent,
    );
  });

  it('declines a deal whose income cannot support any meaningful loan', () => {
    const result = underwrite({ ...CLEVELAND, id: 'ZERO', monthlyGrossRent: 200 });
    expect(result.decision.approved).toBe(false);
  });

  it('responds to a worsening input rather than returning a fixed answer', () => {
    const weaker = underwrite({ ...CLEVELAND, id: 'WEAK', monthlyGrossRent: 1_500 });
    expect(weaker.sizing.loanAmount).toBeLessThan(underwrite(CLEVELAND).sizing.loanAmount);
  });

  it('is interest-only: the monthly payment is one month of interest', () => {
    const { terms } = underwrite(CLEVELAND);
    expect(terms!.monthlyPayment).toBeCloseTo((terms!.loanAmount * terms!.annualRatePercent) / 100 / 12, 6);
    expect(terms!.balloonAtExit).toBe(terms!.loanAmount);
  });
});

describe('validate', () => {
  it('rejects a percentage passed where a decimal was required', () => {
    expect(() => validate({ ...CLEVELAND, vacancyRate: 7 })).toThrow(/decimal/);
    expect(() => validate({ ...CLEVELAND, managementFeeRate: 8 })).toThrow(/decimal/);
  });

  it('rejects a zero or negative term', () => {
    expect(() => validate({ ...CLEVELAND, termMonths: 0 })).toThrow(/termMonths/);
  });

  it('rejects an unknown exit strategy', () => {
    expect(() => validate({ ...CLEVELAND, exitStrategy: 'auction' as never })).toThrow(/exitStrategy/);
  });
});
