import { describe, expect, it, vi } from 'vitest';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx-js-style';
import { formatCurrency } from './currency';
import { formatAuditCreatedAt } from './auditLogExport';
import { buildMonthlyReport, type MonthlyReport, type MonthlyReportMetadata } from './monthlyReport';
import { buildMonthlyReportExcelWorkbook, exportMonthlyReportToPDF } from './monthlyReportExport';

vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));
vi.mock('jspdf', async importOriginal => {
  const actual = await importOriginal<typeof import('jspdf')>();
  return { ...actual, default: class extends actual.default {
    constructor(options?: ConstructorParameters<typeof actual.default>[0]) { super(options); this.save = vi.fn() as any; }
  } };
});

const metadata: MonthlyReportMetadata = {
  dateFrom: '2026-07-01',
  dateTo: '2026-07-31',
  locationName: 'Yangon Main',
  currency: 'MMK',
  generatedAt: new Date('2026-08-01T09:30:00Z')
};

const report: MonthlyReport = {
  rows: [{
    treatmentId: 'treatment-1', date: '2026-07-10', patientId: 'patient-1', patientName: 'Aye Aye', age: 35,
    phone: '0912345', city: 'Yangon', township: 'Bahan', patientType: 'Walk-in', treatment: 'Crown', doctor: 'Doctor One',
    standardCost: 100000, discount: 0, cost: 100000, payment: 60000, balance: 40000, serviceCharges: 0, medicineSales: 0, totalRevenue: 100000,
    materialCost: 10000, labCost: 5000, specialDoctorCost: 0, mlsTotal: 15000, doctorCost: 20000,
    totalCost: 35000, netProfit: 65000, netMargin: 0.65
  }],
  summary: {
    treatmentCount: 1, patientCount: 1, standardProduction: 100000, discount: 0, production: 100000, payment: 60000, balance: 40000,
    balanceCollections: 6000, collectedReceipts: 66000,
    serviceCharges: 0, medicineSales: 0, totalRevenue: 100000, materialCost: 10000, labCost: 5000, specialDoctorCost: 0,
    mlsTotal: 15000, doctorCost: 20000, operatingExpenses: 0, totalCost: 35000, netProfit: 65000,
    netMargin: 0.65, collectionRate: 0.6
  },
  byTreatment: [{ name: 'Crown', treatments: 1, patients: 1, discount: 0, production: 100000, payment: 60000, serviceCharges: 0, medicineSales: 0, totalRevenue: 100000, mlsTotal: 15000, doctorCost: 20000, totalCost: 35000, netProfit: 65000, netMargin: 0.65 }],
  byDoctor: [{ name: 'Doctor One', treatments: 1, patients: 1, discount: 0, production: 100000, payment: 60000, serviceCharges: 0, medicineSales: 0, totalRevenue: 100000, mlsTotal: 15000, doctorCost: 20000, totalCost: 35000, netProfit: 65000, netMargin: 0.65 }],
  byPatientType: [{ name: 'Walk-in', treatments: 1, patients: 1, discount: 0, production: 100000, payment: 60000, serviceCharges: 0, medicineSales: 0, totalRevenue: 100000, mlsTotal: 15000, doctorCost: 20000, totalCost: 35000, netProfit: 65000, netMargin: 0.65 }],
  expenses: []
};

describe('monthly report Excel workbook', () => {
  it('reconciles unassigned revenue with the executive summary without adding treatments', async () => {
    const dated = buildMonthlyReport({ records: [], payments: [], costSummaries: {}, costItems: [],
      medicineSales: [{ id: 'sale', location_id: 'loc', patient_id: 'p', medicine_id: 'm', quantity: 1,
        unit_price: 50, total_price: 50, date: '2026-07-10' }] });
    const workbook = await buildMonthlyReportExcelWorkbook(dated, metadata);
    const detail = workbook.Sheets['Treatment Detail'];
    expect(detail.X4.v).toBe('Net Profit');
    expect(detail.W4.v).toBe('Total Cost (incl. operating expenses)');
    expect(detail.A5.v).toBe('UNASSIGNED REVENUE (no treatment counted)');
    expect(detail.Q5.v).toBe(50);
    expect(detail.P5.v).toBe(50);
    expect(detail.X6.v).toBe(50);
    expect(dated.summary.treatmentCount).toBe(0);
    expect(dated.summary.totalRevenue).toBe(50);
    vi.mocked(autoTable).mockClear();
    exportMonthlyReportToPDF(dated, metadata);
    expect(vi.mocked(autoTable).mock.calls[0][1].head?.[0]).toContain('Contribution (pre-MLS)');
  });

  it('exports PDF costs with both dates and an explicit non-duplicating cost section', () => {
    const datedReport = buildMonthlyReport({ records: [], payments: [], costSummaries: {}, costItems: [{
      id: 'cost-1', expenseDate: '2026-07-15', treatmentDate: '2026-06-10', costType: 'lab', amount: 30,
      patientId: 'patient-1', patientName: 'Aye Aye', treatmentLabel: 'Crown', doctorName: 'Doctor One',
      patientType: 'Walk-in', sourceType: 'payment', sourceId: 'payment-1'
    }] });
    vi.mocked(autoTable).mockClear();
    exportMonthlyReportToPDF(datedReport, metadata);
    const table = vi.mocked(autoTable).mock.calls.map(call => call[1]).find(options =>
      options.head?.[0]?.[0] === 'Expense Date');
    expect(table).toBeDefined();
    expect(table?.head?.[0]).toContain('Original Treatment Date');
    expect(table?.body?.[0]).toEqual(expect.arrayContaining(['2026-07-15', '2026-06-10', 'Crown', 'lab', '30Ks']));
    expect(table?.foot?.[0]).toContain('30Ks');
  });

  it('exports older-treatment MLS as a cost-only adjustment without duplicating treatments', async () => {
    const datedReport = buildMonthlyReport({ records: [], payments: [], costSummaries: {}, costItems: [{
      id: 'cost-1', expenseDate: '2026-07-15', treatmentDate: '2026-06-10', costType: 'lab', amount: 30,
      patientId: 'patient-1', patientName: 'Aye Aye', treatmentLabel: 'Crown', doctorName: 'Doctor One',
      patientType: 'Walk-in', sourceType: 'payment', sourceId: 'payment-1'
    }] });
    const workbook = await buildMonthlyReportExcelWorkbook(datedReport, metadata);
    const costs = workbook.Sheets['MLS Expenses'];
    expect(costs).toBeDefined();
    expect(costs.A4.v).toBe('Expense Date');
    expect(costs.B4.v).toBe('Original Treatment Date');
    expect(costs.A5.v).toBe('2026-07-15');
    expect(costs.B5.v).toBe('2026-06-10');
    expect(costs.H5.v).toBe(30);
    expect(costs.H6.v).toBe(30);
    const detail = workbook.Sheets['Treatment Detail'];
    expect(detail.H5.v).toContain('MLS adjustment: Crown (original 2026-06-10)');
    expect(detail.L5.v).toBe(0);
    expect(detail.U5.v).toBe(30);
    expect(detail.W5.v).toBe(30);
    expect(detail.X6.v).toBe(-30);
    expect(workbook.Sheets['By Treatment'].J5.v).toBe(30);
    expect(workbook.Sheets['By Treatment'].B5.v).toBe(0);
  });

  it('attaches dated MLS to grouped treatments and reconciles costs, revenue and net profit after XLSX round trip', async () => {
    const base = { patientId: 'patient-1', patientName: 'Aye Aye', treatmentLabel: 'Crown',
      treatmentDate: '2026-07-10', doctorName: 'Doctor One', patientType: 'Walk-in',
      sourceType: 'treatment' as const, sourceId: 'treatment-1' };
    const dated = buildMonthlyReport({
      records: [
        { id: 'treatment-1', location_id: 'loc', patient_id: 'patient-1', patient_name: 'Aye Aye',
          doctor_name: 'Doctor One', teeth: [], description: 'Crown', cost: 100, doctorEarnings: 20, date: '2026-07-10' },
        { id: 'treatment-2', location_id: 'loc', patient_id: 'patient-1', patient_name: 'Aye Aye',
          doctor_name: 'Doctor Two', teeth: [], description: 'Filling', cost: 50, doctorEarnings: 10, date: '2026-07-10' }
      ], payments: [], costSummaries: {}, dateFrom: metadata.dateFrom, dateTo: metadata.dateTo,
      costItems: [
        { ...base, id: 'm', expenseDate: '2026-07-01', costType: 'material', amount: 10 },
        { ...base, id: 'l', sourceType: 'payment', sourceId: 'payment-1', expenseDate: '2026-07-31', costType: 'lab', amount: 15 },
        { ...base, id: 's', expenseDate: '2026-07-15', costType: 'special_doctor', amount: 5 },
        { ...base, id: 'old', sourceId: 'old-treatment', treatmentDate: '2026-06-10', expenseDate: '2026-07-15', costType: 'lab', amount: 7 },
        { ...base, id: 'outside', expenseDate: '2026-08-01', costType: 'lab', amount: 999 }
      ],
      medicineSales: [{ id: 'sale', location_id: 'loc', patient_id: 'other', medicine_id: 'm',
        quantity: 1, unit_price: 12, total_price: 12, date: '2026-07-10' }],
      expenses: [{ id: 'expense', location_id: 'loc', date: '2026-07-10', category: 'Rent', description: 'Rent', amount: 9 }]
    });
    const before = structuredClone(dated);
    const workbook = await buildMonthlyReportExcelWorkbook(dated, metadata);
    const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    const detail = reopened.Sheets['Treatment Detail'];
    expect(detail.H5.v).toBe('Crown; Filling');
    expect(detail.R5.v).toBe(10);
    expect(detail.S5.v).toBe(15);
    expect(detail.T5.v).toBe(5);
    expect(detail.U5.v).toBe(30);
    expect(detail.W5.v).toBe(60);
    expect(detail.X5.v).toBe(90);
    expect(detail.Y5.v).toBe(0.6);
    expect(detail.H6.v).toContain('MLS adjustment');
    expect(detail.A7.v).toContain('UNASSIGNED REVENUE');
    expect(detail.A8.v).toContain('OPERATING EXPENSES');
    expect(detail.A9.v).toBe('REPORT TOTAL');
    for (const [column, field] of [['Q', 'totalRevenue'], ['U', 'mlsTotal'], ['W', 'totalCost'],
      ['X', 'netProfit'], ['Y', 'netMargin']] as const) {
      expect(detail[`${column}9`].v).toBeCloseTo(dated.summary[field]);
    }
    expect(dated).toEqual(before);
    expect(dated.summary.treatmentCount).toBe(2);
  });

  it('builds a structured, readable workbook with professional report sections', async () => {
    const workbook = await buildMonthlyReportExcelWorkbook(report, metadata);

    expect(workbook.SheetNames).toEqual([
      'Executive Summary', 'Treatment Detail', 'By Treatment', 'By Clinician', 'By Patient Type', 'Operating Expenses'
    ]);

    const summary = workbook.Sheets['Executive Summary'];
    expect(summary.A1.v).toBe('MONTHLY TREATMENT & PROFITABILITY REPORT');
    expect(summary.A5.v).toBe('REPORT VOLUME & COLLECTIONS');
    expect(summary.D5.v).toBe('REVENUE & COLLECTIONS');
    expect(summary.G5.v).toBe('COSTS & PROFITABILITY');
    expect(summary.E6.z).toBe('#,##0" Ks"');
    expect(summary.E9.z).toBe('#,##0" Ks"');
    expect(summary.H13.z).toBe('#,##0" Ks"');
    expect(summary.H14.z).toBe('0.0%');
    expect(summary.A1.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: '0F172A' } },
      font: { bold: true, color: { rgb: 'FFFFFF' } }
    });
    expect(summary.A5.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: '4F46E5' } },
      border: { bottom: { style: 'medium' } }
    });
    expect(summary.H13.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: 'DCFCE7' } },
      font: { color: { rgb: '166534' } }
    });
    expect(summary['!merges']).toHaveLength(8);
    expect(summary['!freeze']).toMatchObject({ ySplit: 4, topLeftCell: 'A5' });

    const detail = workbook.Sheets['Treatment Detail'];
    expect(detail.A4.v).toBe('Treatment Date');
    expect(detail.B4.v).toBe('Patient Name');
    expect(detail.F4.v).toBe('Township');
    expect(detail.F5.v).toBe('Bahan');
    expect(detail.J4.v).toBe('Standard Production');
    expect(detail.L4.v).toBe('Treatment Production');
    expect(detail.V4.v).toBe('Doctor RF');
    expect(detail.A6.v).toBe('REPORT TOTAL');
    expect(detail.J5.z).toBe('#,##0" Ks"');
    expect(detail.Y5.z).toBe('0.0%');
    expect(detail.A4.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: '4F46E5' } },
      border: { left: { style: 'medium' } }
    });
    expect(detail.A5.s).toMatchObject({ border: { bottom: { style: 'thin' } } });
    expect(detail.X5.s).toMatchObject({ fill: { fgColor: { rgb: 'DCFCE7' } } });
    expect(detail.B6.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: 'E2E8F0' } },
      border: { top: { style: 'medium' }, bottom: { style: 'medium' } }
    });
    expect(detail.A6.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: 'E2E8F0' } },
      border: { top: { style: 'medium' } }
    });
    expect(detail['!autofilter']).toEqual({ ref: 'A4:Y5' });
    expect(detail['!freeze']).toMatchObject({ ySplit: 4, topLeftCell: 'A5' });
    expect(detail['!cols'][7].wch).toBe(32);

    const clinician = workbook.Sheets['By Clinician'];
    expect(clinician.A1.v).toBe('CLINICIAN PERFORMANCE');
    expect(clinician.A4.v).toBe('Clinician');
    expect(clinician.E4.v).toBe('Treatment Production');
    expect(clinician.J4.v).toBe('MLS Total');
    expect(clinician.K4.v).toBe('Doctor Earnings (RF)');
    expect(clinician.K5.v).toBe(20000);
    expect(clinician.L4.v).toBe('Direct Cost');
    expect(clinician.L5.v).toBe(35000);
    expect(clinician.A6.v).toBe('REPORT TOTAL');
  });

  it('preserves report labels and numeric formats in the written XLSX file', async () => {
    const workbook = await buildMonthlyReportExcelWorkbook(report, metadata);
    const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true, cellStyles: true });
    const reopened = XLSX.read(file, { type: 'buffer', cellNF: true, cellStyles: true });
    const detail = reopened.Sheets['Treatment Detail'];

    expect(detail.B5.v).toBe('Aye Aye');
    expect(detail.F5.v).toBe('Bahan');
    expect(detail.J5.v).toBe(100000);
    expect(detail.J5.z).toBe('#,##0" Ks"');
    expect(detail.Y5.v).toBe(0.65);
    expect(detail.Y5.z).toBe('0.0%');
    expect(detail.A4.s?.fgColor?.rgb).toBe('4F46E5');
    expect(detail.X5.s?.fgColor?.rgb).toBe('DCFCE7');
    expect(detail.A6.v).toBe('REPORT TOTAL');
    expect(reopened.Props?.Title).toBe('Monthly Clinic & Profitability Report');

    const uncompressed = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: false, cellStyles: true });
    const openXml = uncompressed.toString('utf8');
    expect(openXml).toContain('<borders count=');
    expect(openXml).toContain('style="medium"');
    expect(openXml).toContain('4F46E5');
    expect(openXml).toContain('CBD5E1');
  });

  it('exports service, medicine, discount, MLS, and operating expense sections', async () => {
    const expandedReport: MonthlyReport = {
      ...report,
      rows: [{
        ...report.rows[0], standardCost: 110000, discount: 10000, serviceCharges: 5000,
        medicineSales: 10000, totalRevenue: 115000, mlsTotal: 15000, netProfit: 80000, netMargin: 80000 / 115000
      }],
      summary: {
        ...report.summary, standardProduction: 110000, discount: 10000, serviceCharges: 5000,
        medicineSales: 10000, totalRevenue: 115000, mlsTotal: 15000, operatingExpenses: 7000,
        totalCost: 42000, netProfit: 73000, netMargin: 73000 / 115000
      },
      byTreatment: [{
        ...report.byTreatment[0], discount: 10000, serviceCharges: 5000, medicineSales: 10000,
        totalRevenue: 115000, mlsTotal: 15000, netProfit: 80000, netMargin: 80000 / 115000
      }],
      byDoctor: [{
        ...report.byDoctor[0], discount: 10000, serviceCharges: 5000, medicineSales: 10000,
        totalRevenue: 115000, mlsTotal: 15000, netProfit: 80000, netMargin: 80000 / 115000
      }],
      byPatientType: [{
        ...report.byPatientType[0], discount: 10000, serviceCharges: 5000, medicineSales: 10000,
        totalRevenue: 115000, mlsTotal: 15000, netProfit: 80000, netMargin: 80000 / 115000
      }],
      expenses: [{ id: 'expense-1', location_id: 'location-1', date: '2026-07-10', category: 'Rent', description: 'Clinic rent', amount: 7000 }]
    };
    const workbook = await buildMonthlyReportExcelWorkbook(expandedReport, metadata);

    expect(workbook.Sheets['Executive Summary'].D9.v).toBe('Service Charges');
    expect(workbook.Sheets['Executive Summary'].D10.v).toBe('Medicine Sales');
    expect(workbook.Sheets['Executive Summary'].G9.v).toBe('MLS Total');
    expect(workbook.Sheets['Executive Summary'].G11.v).toBe('Operating Expenses');
    // Reconciliation lines: previous-debt collections and the all-receipts total.
    expect(workbook.Sheets['Executive Summary'].A5.v).toBe('REPORT VOLUME & COLLECTIONS');
    expect(workbook.Sheets['Executive Summary'].A8.v).toBe('Balance Collections (Prev. Debt)');
    expect(workbook.Sheets['Executive Summary'].B8.v).toBe(6000);
    expect(workbook.Sheets['Executive Summary'].B8.z).toBe('#,##0" Ks"');
    expect(workbook.Sheets['Executive Summary'].A9.v).toBe('Total Collected Receipts');
    expect(workbook.Sheets['Executive Summary'].B9.v).toBe(66000);
    expect(workbook.Sheets['Treatment Detail'].O4.v).toBe('Service Charges');
    expect(workbook.Sheets['Treatment Detail'].P4.v).toBe('Medicine Sales');
    expect(workbook.Sheets['Treatment Detail'].U4.v).toBe('MLS Total');
    expect(workbook.Sheets['By Clinician'].J4.v).toBe('MLS Total');
    expect(workbook.Sheets['Operating Expenses'].D5.v).toBe(7000);
  });

  it('keeps empty reporting periods structured and filterable', async () => {
    const emptyReport: MonthlyReport = {
      rows: [],
      summary: {
        treatmentCount: 0, patientCount: 0, standardProduction: 0, discount: 0, production: 0, payment: 0, balance: 0,
        balanceCollections: 0, collectedReceipts: 0,
        serviceCharges: 0, medicineSales: 0, totalRevenue: 0, materialCost: 0, labCost: 0, specialDoctorCost: 0,
        mlsTotal: 0, doctorCost: 0, operatingExpenses: 0, totalCost: 0, netProfit: 0, netMargin: 0, collectionRate: 0
      },
      byTreatment: [],
      byDoctor: [],
      byPatientType: [],
      expenses: []
    };
    const workbook = await buildMonthlyReportExcelWorkbook(emptyReport, metadata);
    const detail = workbook.Sheets['Treatment Detail'];

    expect(detail.A4.v).toBe('Treatment Date');
    expect(detail.A5.v).toBe('REPORT TOTAL');
    expect(detail.J5.v).toBe(0);
    expect(detail.J5.z).toBe('#,##0" Ks"');
    expect(detail['!autofilter']).toEqual({ ref: 'A4:Y4' });
  });

  it('uses an explicit loss treatment without changing the underlying numeric value', async () => {
    const lossReport: MonthlyReport = {
      ...report,
      rows: [{ ...report.rows[0], netProfit: -5000, netMargin: -0.05 }],
      summary: { ...report.summary, netProfit: -5000, netMargin: -0.05 },
      byTreatment: [{ ...report.byTreatment[0], netProfit: -5000, netMargin: -0.05 }],
      byDoctor: [{ ...report.byDoctor[0], netProfit: -5000, netMargin: -0.05 }],
      byPatientType: [{ ...report.byPatientType[0], netProfit: -5000, netMargin: -0.05 }]
    };
    const workbook = await buildMonthlyReportExcelWorkbook(lossReport, metadata);
    const detail = workbook.Sheets['Treatment Detail'];

    expect(detail.X5.v).toBe(-5000);
    expect(detail.X5.s).toMatchObject({
      fill: { patternType: 'solid', fgColor: { rgb: 'FEE2E2' } },
      font: { color: { rgb: 'B91C1C' } }
    });
    expect(workbook.Sheets['Executive Summary'].H13.s?.fill?.fgColor?.rgb).toBe('FEE2E2');
  });

  it('exports same-patient same-day treatments as one detail row without changing treatment analysis', async () => {
    const groupedReport: MonthlyReport = {
      ...report,
      rows: [
        report.rows[0],
        { ...report.rows[0], treatmentId: 'treatment-2', treatment: 'Filling', doctor: 'Doctor Two', standardCost: 50000, cost: 50000, totalRevenue: 50000, payment: 30000, balance: 20000, materialCost: 5000, labCost: 0, mlsTotal: 5000, doctorCost: 10000, totalCost: 15000, netProfit: 35000, netMargin: 0.7 },
        { ...report.rows[0], treatmentId: 'treatment-3', treatment: 'Crown', standardCost: 25000, cost: 25000, totalRevenue: 25000, payment: 10000, balance: 15000, materialCost: 0, labCost: 5000, mlsTotal: 5000, doctorCost: 5000, totalCost: 10000, netProfit: 15000, netMargin: 0.6 },
        { ...report.rows[0], treatmentId: 'treatment-4', treatment: 'Scaling', doctor: 'Doctor Two', standardCost: 25000, cost: 25000, totalRevenue: 25000, payment: 0, balance: 25000, materialCost: 0, labCost: 0, mlsTotal: 0, doctorCost: 5000, totalCost: 5000, netProfit: 20000, netMargin: 0.8 }
      ],
      summary: {
        treatmentCount: 4, patientCount: 1, standardProduction: 200000, discount: 0, production: 200000, payment: 100000, balance: 100000,
        balanceCollections: 0, collectedReceipts: 100000,
        serviceCharges: 0, medicineSales: 0, totalRevenue: 200000, materialCost: 15000, labCost: 10000, specialDoctorCost: 0,
        mlsTotal: 25000, doctorCost: 40000, operatingExpenses: 0, totalCost: 65000, netProfit: 135000,
        netMargin: 0.675, collectionRate: 0.5
      },
      byTreatment: [
        { name: 'Crown', treatments: 2, patients: 1, discount: 0, production: 125000, payment: 70000, serviceCharges: 0, medicineSales: 0, totalRevenue: 125000, mlsTotal: 15000, doctorCost: 30000, totalCost: 45000, netProfit: 80000, netMargin: 0.64 },
        { name: 'Filling', treatments: 1, patients: 1, discount: 0, production: 50000, payment: 30000, serviceCharges: 0, medicineSales: 0, totalRevenue: 50000, mlsTotal: 5000, doctorCost: 10000, totalCost: 15000, netProfit: 35000, netMargin: 0.7 },
        { name: 'Scaling', treatments: 1, patients: 1, discount: 0, production: 25000, payment: 0, serviceCharges: 0, medicineSales: 0, totalRevenue: 25000, mlsTotal: 0, doctorCost: 5000, totalCost: 5000, netProfit: 20000, netMargin: 0.8 }
      ]
    };

    const workbook = await buildMonthlyReportExcelWorkbook(groupedReport, metadata);
    const detail = workbook.Sheets['Treatment Detail'];
    const byTreatment = workbook.Sheets['By Treatment'];

    expect(detail.H5.v).toBe('Crown ×2; Filling; Scaling');
    expect(detail.I5.v).toBe('Doctor One; Doctor Two');
    expect(detail.L5.v).toBe(200000);
    expect(detail.X5.v).toBe(135000);
    expect(detail.Y5.v).toBe(0.675);
    expect(detail.A6.v).toBe('REPORT TOTAL');
    expect(detail['!autofilter']).toEqual({ ref: 'A4:Y5' });
    expect(byTreatment.A5.v).toBe('Crown');
    expect(byTreatment.B5.v).toBe(2);
    expect(byTreatment.A8.v).toBe('REPORT TOTAL');
  });
  it('adds a Payments sheet that lists every payment record with active-only totals', async () => {
    const reportWithPayments: MonthlyReport = {
      ...report,
      payments: [
        { id: 'payment-1', patientId: 'patient-1', patient_name: 'Aye Aye', patient_type: 'Walk-in',
          amount: 60000, date: '2026-07-10', type: 'PARTIAL', remainingBalance: 40000, balanceBefore: 100000,
          paymentMethod: 'CASH', treatmentIds: ['treatment-1'], receiptNumber: 'R-1001', createdByUserName: 'Staff A',
          doctorEarned: 6000 },
        { id: 'payment-2', patientId: 'patient-2', patient_name: 'Bo Bo', patient_type: 'Member',
          amount: 30000, date: '2026-07-12', type: 'FULL', remainingBalance: 0,
          paymentMethod: 'KPAY', treatmentIds: ['treatment-2'], receiptNumber: 'R-1002', createdByUserName: 'Staff B',
          createdAt: '2026-07-12T03:15:00Z',
          doctorEarned: 3000 },
        { id: 'payment-3', patientId: 'patient-3', patient_name: 'Voided Patient', amount: 5000, date: '2026-07-13',
          type: 'PARTIAL', remainingBalance: 5000, voidedAt: '2026-07-14T00:00:00Z' },
        // A collection against an older remaining balance: it has no treatment
        // row inside this report period, so it is not allocated to any in-range
        // treatment, but it must still be listed here.
        { id: 'payment-4', patientId: 'patient-4', patient_name: 'Daw Mya', patient_type: 'Walk-in',
          amount: 25000, date: '2026-07-15', type: 'PARTIAL', remainingBalance: 0, balanceBefore: 25000,
          paymentMethod: 'CASH', treatmentIds: [], receiptNumber: 'R-1004', createdByUserName: 'Staff C' }
      ]
    };
    const workbook = await buildMonthlyReportExcelWorkbook(reportWithPayments, metadata);
    expect(workbook.SheetNames).toContain('Payments');
    const sheet = workbook.Sheets['Payments'];

    expect(sheet.A4.v).toBe('Date / Time');
    expect(sheet.G4.v).toBe('Amount');
    expect(sheet.K4.v).toBe('Doctor Earned');
    expect(sheet.L4.v).toBe('Status');
    expect(sheet.A5.v).toBe('2026-07-10');
    // The date column shows the recorded date/time exactly as the Audit Log
    // payments tab renders it for the same receipt.
    expect(sheet.A6.v).toBe(formatAuditCreatedAt('2026-07-12T03:15:00Z'));
    expect(sheet.C5.v).toBe('Aye Aye');
    expect(sheet.F5.v).toBe('CASH');
    expect(sheet.G5.v).toBe(60000);
    // Doctor commission follows the receipt so the sheet matches the payment log.
    expect(sheet.K5.v).toBe(6000);
    expect(sheet.K6.v).toBe(3000);
    expect(sheet.L5.v).toBe('Active');
    expect(sheet.L6.v).toBe('Active');
    expect(sheet.L7.v).toBe('Voided');
    // Balance-only collection is listed with its balance snapshot even though
    // it is not tied to any treatment in this report.
    expect(sheet.A8.v).toBe('2026-07-15');
    expect(sheet.C8.v).toBe('Daw Mya');
    expect(sheet.G8.v).toBe(25000);
    expect(sheet.H8.v).toBe(25000);
    expect(sheet.I8.v).toBe(0);
    expect(sheet.J8.v).toBe(0);
    expect(sheet.L8.v).toBe('Active');
    expect(sheet.A9.v).toBe('TOTAL (active payments)');
    expect(sheet.G9.v).toBe(115000);

    // The PDF professional report also lists every payment and shows the same
    // reconciliation totals as the Excel summary.
    vi.mocked(autoTable).mockClear();
    exportMonthlyReportToPDF(reportWithPayments, metadata);
    const paymentTable = vi.mocked(autoTable).mock.calls.find(call => call[1].head?.[0]?.[0] === 'Date / Time');
    expect(paymentTable).toBeTruthy();
    expect(paymentTable?.[1].head?.[0]).toContain('Receipt No.');
    expect(paymentTable?.[1].head?.[0]).toContain('Remaining Balance');
    expect(paymentTable?.[1].body).toHaveLength(4);
    expect(paymentTable?.[1].foot?.[0]?.[0]).toBe('TOTAL (active payments)');
    expect(paymentTable?.[1].foot?.[0]?.[6]).toBe(formatCurrency(115000, 'MMK'));
    // The PDF table carries the same per-receipt doctor commission as the log.
    expect(paymentTable?.[1].body?.[0]?.[10]).toBe(formatCurrency(6000, 'MMK'));
    expect(paymentTable?.[1].body?.[1]?.[10]).toBe(formatCurrency(3000, 'MMK'));
  });


});
