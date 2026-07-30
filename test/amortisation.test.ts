import { describe, expect, it } from 'vitest';
import {
  interestOnlyAnnualDebtService,
  periodicPayment,
  principalFromAmortisingDebtService,
  principalFromInterestOnlyDebtService,
  schedule,
  totalInterest,
} from '../src/underwriting/amortisation';

/**
 * The amortisation tests are checked against a schedule computed by hand, not
 * against the implementation's own output. If the periodic payment is wrong every
 * downstream number is wrong, and the ledger will not tell you — it will accept
 * the loan and amortise on its own arithmetic.
 */

describe('periodicPayment', () => {
  it('matches a hand-computed 12-month schedule at 9.5% annual', () => {
    // P = 100,000, r = 0.095/12 = 0.0079166667, n = 12
    //   (1+r)^12    = 1.0992475841
    //   (1+r)^-12   = 0.9097131661
    //   1 - (1+r)^-12 = 0.0902868339
    //   A = 100000 x 0.0079166667 / 0.0902868339 = 791.66667 / 0.0902868339
    //     = 8768.351177
    expect(periodicPayment(100_000, 0.095 / 12, 12)).toBeCloseTo(8768.351177, 5);
  });

  it('matches a hand-computed 6-period schedule at 1% per period', () => {
    //   (1.01)^6  = 1.061520150601
    //   (1.01)^-6 = 0.9420452353
    //   A = 50000 x 0.01 / (1 - 0.9420452353) = 500 / 0.0579547647
    //     = 8627.418336
    expect(periodicPayment(50_000, 0.01, 6)).toBeCloseTo(8627.418336, 5);
  });

  it('fully retires the balance when the schedule is simulated forward', () => {
    // An independent check of the annuity formula: apply interest then subtract
    // the payment, six times, and the balance should land on zero.
    const payment = periodicPayment(50_000, 0.01, 6);
    let balance = 50_000;
    for (let i = 0; i < 6; i++) balance = balance * 1.01 - payment;
    expect(balance).toBeCloseTo(0, 6);
  });

  it('degenerates to straight-line at a zero rate', () => {
    expect(periodicPayment(12_000, 0, 12)).toBe(1_000);
  });

  it('rejects nonsense inputs rather than returning NaN', () => {
    expect(() => periodicPayment(1000, 0.01, 0)).toThrow(/periods/);
    expect(() => periodicPayment(-1, 0.01, 12)).toThrow(/principal/);
    expect(() => periodicPayment(1000, -0.01, 12)).toThrow(/rate/);
  });
});

describe('schedule', () => {
  const rows = schedule(100_000, 0.095 / 12, 12);

  it('runs for exactly the requested number of periods', () => {
    expect(rows).toHaveLength(12);
  });

  it('opens at the full principal', () => {
    expect(rows[0]!.openingBalance).toBe(100_000);
  });

  it('charges first-period interest of P x r', () => {
    expect(rows[0]!.interest).toBeCloseTo(100_000 * (0.095 / 12), 6);
    expect(rows[0]!.interest).toBeCloseTo(791.67, 2);
  });

  it('closes at exactly zero, with no rounding residue', () => {
    expect(rows.at(-1)!.closingBalance).toBe(0);
  });

  it('repays exactly the principal across all periods', () => {
    const principalRepaid = rows.reduce((sum, row) => sum + row.principal, 0);
    expect(principalRepaid).toBeCloseTo(100_000, 6);
  });

  it('shifts the mix from interest toward principal over time', () => {
    expect(rows[0]!.interest).toBeGreaterThan(rows.at(-1)!.interest);
    expect(rows[0]!.principal).toBeLessThan(rows.at(-1)!.principal);
  });

  it('has each closing balance equal the next opening balance', () => {
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i]!.closingBalance).toBeCloseTo(rows[i + 1]!.openingBalance, 9);
    }
  });
});

describe('totalInterest', () => {
  it('matches payment x periods less principal', () => {
    const payment = periodicPayment(100_000, 0.095 / 12, 12);
    expect(totalInterest(100_000, 0.095 / 12, 12)).toBeCloseTo(payment * 12 - 100_000, 4);
  });

  it('is zero at a zero rate', () => {
    expect(totalInterest(100_000, 0, 12)).toBe(0);
  });
});

describe('interest-only debt service', () => {
  it('is principal x annual rate', () => {
    expect(interestOnlyAnnualDebtService(500_000, 9.5)).toBeCloseTo(47_500, 6);
  });

  it('inverts exactly', () => {
    const principal = principalFromInterestOnlyDebtService(47_500, 9.5);
    expect(principal).toBeCloseTo(500_000, 6);
  });

  it('returns zero rather than Infinity at a zero rate', () => {
    expect(principalFromInterestOnlyDebtService(47_500, 0)).toBe(0);
  });

  it('is materially smaller than amortising debt service on a short term', () => {
    // The reason underwriting uses interest-only: a 12-month amortising schedule
    // charges the property with repaying all its principal from one year of NOI.
    const amortising = periodicPayment(500_000, 0.095 / 12, 12) * 12;
    expect(amortising).toBeGreaterThan(interestOnlyAnnualDebtService(500_000, 9.5) * 10);
  });
});

describe('principalFromAmortisingDebtService', () => {
  it('inverts periodicPayment', () => {
    const annualService = periodicPayment(250_000, 0.08 / 12, 24) * 12;
    expect(principalFromAmortisingDebtService(annualService, 8, 24)).toBeCloseTo(250_000, 4);
  });

  it('returns zero for a non-positive budget', () => {
    expect(principalFromAmortisingDebtService(0, 8, 24)).toBe(0);
    expect(principalFromAmortisingDebtService(-100, 8, 24)).toBe(0);
  });
});
