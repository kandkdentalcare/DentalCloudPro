import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => {
  const state: any = { rowsByTable: {}, rangesByTable: {}, filtersByTable: {}, inFiltersByTable: {} };

  state.from = vi.fn((table: string) => ({
    select: vi.fn(() => {
      let from = 0;
      let to = 999;
      const inFilters: [string, unknown[]][] = [];
      const query: any = {
        order: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          (state.filtersByTable[table] ||= []).push(['eq', column, value]);
          return query;
        }),
        gte: vi.fn((column: string, value: unknown) => {
          (state.filtersByTable[table] ||= []).push(['gte', column, value]);
          return query;
        }),
        lte: vi.fn((column: string, value: unknown) => {
          (state.filtersByTable[table] ||= []).push(['lte', column, value]);
          return query;
        }),
        lt: vi.fn((column: string, value: unknown) => {
          (state.filtersByTable[table] ||= []).push(['lt', column, value]);
          return query;
        }),
        in: vi.fn((column: string, values: unknown[]) => {
          (state.filtersByTable[table] ||= []).push(['in', column, values]);
          inFilters.push([column, values]);
          return query;
        }),
        or: vi.fn(() => query),
        range: vi.fn((nextFrom: number, nextTo: number) => {
          from = nextFrom;
          to = nextTo;
          (state.rangesByTable[table] ||= []).push([from, to]);
          return query;
        }),
        then: (resolve: any, reject: any) => {
          // Mirror PostgREST: an `.in()` filter only returns the matching rows.
          const matchingRows = (state.rowsByTable[table] || []).filter((row: any) => (
            inFilters.every(([column, values]) => values.includes(row[column]))
          ));
          return Promise.resolve({
            data: matchingRows.slice(from, to + 1),
            error: null
          }).then(resolve, reject);
        }
      };
      return query;
    })
  }));

  return state;
});

vi.mock('./supabase', () => ({
  supabase: { from: supabaseMock.from, rpc: vi.fn() },
  supabaseUrl: '',
  supabaseAnonKey: ''
}));

import { api } from './api';

const rows = (table: string) => Array.from({ length: 1001 }, (_, index) => ({
  id: `${table}-${String(index).padStart(4, '0')}`,
  location_id: 'location-1',
  patient_id: 'patient-1',
  appointment_id: 'appointment-1',
  patient_name: 'Patient One',
  original_date: '2026-08-05',
  new_date: '2026-08-06',
  reason: 'Schedule change',
  created_at: '2026-08-05T00:00:00Z',
  date: '2026-08-05',
  medicine_id: 'medicine-1',
  quantity: 1,
  unit_price: 100,
  total_price: 100,
  points: 1,
  type: 'EARNED',
  description: 'Test',
  sender_id: 'patient-1',
  sender_type: 'patient',
  recipient_id: 'admin-1',
  recipient_type: 'admin',
  content: 'Message',
  timestamp: '2026-08-05T00:00:00Z',
  read: false,
  conversation_id: 'conversation-1',
  amount: 100,
  payment_date: '2026-08-05'
}));

describe('high-volume Supabase fetches', () => {
  beforeEach(() => {
    supabaseMock.rowsByTable = { patient_material_costs: [] };
    supabaseMock.rangesByTable = {};
    supabaseMock.filtersByTable = {};
    supabaseMock.from.mockClear();
  });

  it('loads records after the first 1,000 rows for every production history fetch', async () => {
    for (const table of ['appointment_reschedule_logs', 'payments', 'expenses', 'medicine_sales', 'loyalty_transactions', 'messages']) {
      supabaseMock.rowsByTable[table] = rows(table);
    }
    vi.spyOn(api.messages, 'performAutomaticCleanup').mockResolvedValue(undefined);

    const results = await Promise.all([
      api.appointmentRescheduleLogs.getAll('location-1'),
      api.finance.getPayments('location-1'),
      api.expenses.getAll('location-1'),
      api.medicines.getSales('location-1'),
      api.loyalty.getTransactions('patient-1', 'location-1'),
      api.messages.getMessages('conversation-1')
    ]);

    results.forEach((result) => expect(result).toHaveLength(1001));
    for (const table of ['appointment_reschedule_logs', 'payments', 'expenses', 'medicine_sales', 'loyalty_transactions', 'messages']) {
      expect(supabaseMock.rangesByTable[table]).toEqual([[0, 999], [1000, 1999]]);
    }
  });

  it('applies the selected audit date range at the database query', async () => {
    await Promise.all([
      api.treatments.getAllRecords('location-1', {
        limit: null,
        dateFrom: '2026-08-06',
        dateTo: '2026-08-06',
        includeCommissionEntries: false
      }),
      api.appointments.getAll('location-1', { dateFrom: '2026-08-06', dateTo: '2026-08-06' }),
      api.finance.getPayments('location-1', { dateFrom: '2026-08-06', dateTo: '2026-08-06' }),
      api.appointmentRescheduleLogs.getAll('location-1', { dateFrom: '2026-08-06', dateTo: '2026-08-06' })
    ]);

    expect(supabaseMock.filtersByTable.treatments).toEqual(expect.arrayContaining([
      ['eq', 'location_id', 'location-1'],
      ['gte', 'date', '2026-08-06'],
      ['lte', 'date', '2026-08-06']
    ]));
    expect(supabaseMock.filtersByTable.appointments).toEqual(expect.arrayContaining([
      ['gte', 'date', '2026-08-06'],
      ['lte', 'date', '2026-08-06']
    ]));
    expect(supabaseMock.filtersByTable.payments).toEqual(expect.arrayContaining([
      ['gte', 'payment_date', '2026-08-06'],
      ['lte', 'payment_date', '2026-08-06']
    ]));
    expect(supabaseMock.filtersByTable.appointment_reschedule_logs).toEqual(expect.arrayContaining([
      ['gte', 'created_at', expect.any(String)],
      ['lt', 'created_at', expect.any(String)]
    ]));
    expect(supabaseMock.from).not.toHaveBeenCalledWith('doctor_commission_entries');
  });

  it('filters Clinical Focus payment history by patient at the database', async () => {
    await api.finance.getPayments('location-1', { patientId: 'patient-1' });

    expect(supabaseMock.filtersByTable.payments).toEqual(expect.arrayContaining([
      ['eq', 'location_id', 'location-1'],
      ['eq', 'patient_id', 'patient-1']
    ]));
  });

  it('loads receipts voided inside the monthly report period for the audit payments tab', async () => {
    supabaseMock.rowsByTable.payments = rows('payments');
    supabaseMock.rowsByTable.doctor_commission_entries = [
      { id: 'entry-1', payment_id: 'payments-0000', earnings: 750 },
      { id: 'entry-2', payment_id: 'payments-0000', earnings: 250 }
    ];

    const payments = await api.finance.getMonthlyReportPayments({
      locationId: 'location-1',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
      patientIds: ['patient-1']
    });

    expect(payments).toHaveLength(1001);
    // A receipt voided inside the period is listed by the Audit Log on its void
    // date, so the report query must load it even when it is dated earlier.
    expect(supabaseMock.filtersByTable.payments).toEqual(expect.arrayContaining([
      ['eq', 'location_id', 'location-1'],
      ['lte', 'payment_date', '2026-08-31'],
      ['gte', 'payment_date', '2026-08-01'],
      ['gte', 'voided_at', '2026-08-01T00:00:00'],
      ['lte', 'voided_at', '2026-08-31T23:59:59.999']
    ]));
    // The stored commission ledger total of a receipt is attached so the report
    // shows the same "Doctor Earned" value as the Audit Log → Payments tab.
    expect(payments.find(payment => payment.id === 'payments-0000')?.doctorEarned).toBe(1000);
    expect(payments.find(payment => payment.id === 'payments-0001')?.doctorEarned).toBeUndefined();
  });
});
