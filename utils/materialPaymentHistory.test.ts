import { describe, expect, it } from 'vitest';
import type { ClinicalRecord, PaymentRecord } from '../types';
import { buildMaterialPaymentHistoryRows, filterMaterialPaymentHistoryRows } from './materialPaymentHistory';

const treatment = (overrides: Partial<ClinicalRecord> = {}): ClinicalRecord => ({
  id: 't1', location_id: 'loc1', patient_id: 'p1', patient_name: 'Patient One',
  patient_unique_id: 'PAT-001', doctor_id: 'd1', doctor_name: 'Doctor One', teeth: [],
  description: 'Filling', cost: 1000, date: '2026-09-01', ...overrides
});

const payment = (overrides: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id: 'pay1', patientId: 'p1', amount: 400, clearedAmount: 400, date: '2026-09-01',
  type: 'PARTIAL', remainingBalance: 600, paymentMethod: 'CASH', receiptNumber: 'REC-001',
  treatmentIds: ['t1'], ...overrides
});

describe('material payment history', () => {
  it('keeps partial and final collections as separate receipt rows', () => {
    const rows = buildMaterialPaymentHistoryRows([treatment()], [
      payment(),
      payment({ id: 'pay2', amount: 600, clearedAmount: 600, type: 'FULL', remainingBalance: 0, receiptNumber: 'REC-002', createdAt: '2026-09-02T10:00:00Z', date: '2026-09-02' })
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.receiptNumber)).toEqual(['REC-002', 'REC-001']);
    expect(rows.map((row) => row.totalPaid)).toEqual([600, 400]);
    expect(rows.map((row) => row.appliedToTreatment)).toEqual([600, 400]);
    expect(rows.map((row) => row.treatmentIds)).toEqual([['t1'], ['t1']]);
  });

  it('hides voided collections and keeps them out of treatment allocation', () => {
    const rows = buildMaterialPaymentHistoryRows([treatment()], [
      payment({ id: 'void', voidedAt: '2026-09-01T12:00:00Z', receiptNumber: 'VOID-REC' }),
      payment({ id: 'active', receiptNumber: 'ACTIVE-REC' })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].receiptNumber).toBe('ACTIVE-REC');
    expect(rows[0].appliedToTreatment).toBe(400);
  });

  it('uses the immutable commission ledger amount for each payment', () => {
    const rows = buildMaterialPaymentHistoryRows([
      treatment({ doctorEarningEntries: [{ paymentId: 'pay1', treatmentId: 't1', doctorId: 'd1', paymentDate: '2026-09-01', treatmentDate: '2026-09-01', calculationMode: 'percentage', allocatedPayment: 400, commissionRate: 10, earnings: 40 }] })
    ], [payment()]);
    expect(rows[0].doctorEarned).toBe(40);
  });

  it('filters individual collection rows by date and search fields', () => {
    const rows = buildMaterialPaymentHistoryRows([treatment()], [payment()]);
    expect(filterMaterialPaymentHistoryRows(rows, { dateFrom: '2026-09-01', dateTo: '2026-09-01', patientSearchTerm: 'PAT-001', doctorSearchTerm: 'doctor one', treatmentSearchTerm: 'fill' })).toHaveLength(1);
    expect(filterMaterialPaymentHistoryRows(rows, { dateFrom: '2026-09-02', dateTo: '', patientSearchTerm: '', doctorSearchTerm: '', treatmentSearchTerm: '' })).toHaveLength(0);
  });
});
