import type { Appointment, ClinicalRecord, Expense, MedicineSale, PaymentRecord, TreatmentCostSummary } from '../types';
import type { Currency } from './currency';
import { allocateCommissionablePayments } from './doctorCommissionLedger';
import {
  dedupePaymentRecords,
  getPaymentTreatmentIds,
  getPaymentTreatmentShare
} from './paymentTreatmentAllocation';
import { chunkUniqueIds, REPORT_URL_BATCH_SIZE } from './reportBatching';
import { getPaymentServiceFeeAmount } from './serviceFee';
import { getAuditLogEventDate } from './auditLogFilters';
import { buildAuditLogRows, type AuditExportRow } from './auditLogExport';

export interface MonthlyReportSourceRecord extends ClinicalRecord {
  patient_age?: number | null;
  patient_phone?: string | null;
  patient_city?: string | null;
  patient_township?: string | null;
  patient_balance?: number | null;
}

export interface MonthlyReportCostItem {
  locationId?: string;
  id: string;
  expenseDate: string;
  costType: 'material' | 'lab' | 'special_doctor';
  amount: number;
  patientId: string;
  patientName: string;
  treatmentLabel: string;
  treatmentDate: string;
  doctorName: string;
  patientType: string;
  sourceType: 'treatment' | 'payment';
  sourceId: string;
}

export interface MonthlyReportData {
  costItems?: MonthlyReportCostItem[];
  records: MonthlyReportSourceRecord[];
  allocationRecords?: MonthlyReportSourceRecord[];
  payments: PaymentRecord[];
  costSummaries: Record<string, TreatmentCostSummary>;
  paymentCostSummaries?: Record<string, TreatmentCostSummary>;
  dateFrom?: string;
  dateTo?: string;
  appointments?: Appointment[];
  medicineSales?: MedicineSale[];
  expenses?: Expense[];
}

// A receipt listed in the report Payments table. It is an Audit Log payment row,
// so it carries the recorded timestamp, the clinician names and the doctor
// commission that the Audit Log → Payments tab shows for the same receipt.
export type MonthlyReportPayment = PaymentRecord & {
  _doctorName?: string;
  _treatmentDiscountAmount?: number;
};

export interface MonthlyReportRow {
  treatmentId: string;
  date: string;
  patientId: string;
  patientName: string;
  age: number | null;
  phone: string;
  city: string;
  township: string;
  patientType: string;
  treatment: string;
  doctor: string;
  standardCost: number;
  discount: number;
  cost: number;
  payment: number;
  balance: number;
  serviceCharges: number;
  medicineSales: number;
  totalRevenue: number;
  labCost: number;
  materialCost: number;
  specialDoctorCost: number;
  mlsTotal: number;
  doctorCost: number;
  totalCost: number;
  netProfit: number;
  netMargin: number;
}

export interface MonthlyReportDetailRow extends MonthlyReportRow {
  treatmentIds: string[];
  treatmentCount: number;
}

export interface MonthlyReportSummary {
  treatmentCount: number;
  patientCount: number;
  standardProduction: number;
  discount: number;
  production: number;
  payment: number;
  balance: number;
  // Receipts collected in the report period that were applied to treatments
  // dated before the report period (previous debt / remaining balance).
  balanceCollections: number;
  // Total of every active receipt in the report period (matches the Payments
  // sheet total and the Audit Log → Payments tab). Includes treatment payments,
  // previous-debt collections, service fees and any non-treatment charges.
  collectedReceipts: number;
  serviceCharges: number;
  medicineSales: number;
  totalRevenue: number;
  labCost: number;
  materialCost: number;
  specialDoctorCost: number;
  mlsTotal: number;
  doctorCost: number;
  operatingExpenses: number;
  totalCost: number;
  netProfit: number;
  netMargin: number;
  collectionRate: number;
}

export interface MonthlyReportGroup {
  name: string;
  treatments: number;
  patients: number;
  discount: number;
  production: number;
  payment: number;
  serviceCharges: number;
  medicineSales: number;
  totalRevenue: number;
  mlsTotal: number;
  doctorCost: number;
  totalCost: number;
  netProfit: number;
  netMargin: number;
}

export interface MonthlyReport {
  costItems?: MonthlyReportCostItem[];
  payments?: MonthlyReportPayment[];
  rows: MonthlyReportRow[];
  summary: MonthlyReportSummary;
  byTreatment: MonthlyReportGroup[];
  byDoctor: MonthlyReportGroup[];
  byPatientType: MonthlyReportGroup[];
  expenses: Expense[];
}

export interface MonthlyReportMetadata {
  dateFrom: string;
  dateTo: string;
  locationName: string;
  currency: Currency;
  generatedAt?: Date;
}

export interface MonthlyReportProgress {
  percent: number;
  label: string;
}

export type MonthlyReportProgressCallback = (progress: MonthlyReportProgress) => void;

// Keep PostgREST `in.(...)` URLs below production proxy limits. Larger UUID batches can
// be rejected by the gateway before CORS headers are added, which browsers report as a
// misleading CORS failure rather than an HTTP 414/502 response.
export const MONTHLY_REPORT_PATIENT_BATCH_SIZE = REPORT_URL_BATCH_SIZE;

export const chunkMonthlyReportPatientIds = (patientIds: string[]): string[][] => chunkUniqueIds(patientIds);

const money = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
};

const positiveMoney = (value: unknown): number => Math.max(0, money(value));

const combineLabels = (labels: string[]): string => {
  const counts = new Map<string, number>();
  labels.forEach(label => counts.set(label, (counts.get(label) || 0) + 1));
  return Array.from(counts, ([label, count]) => count > 1 ? `${label} ×${count}` : label).join('; ');
};

const combineDistinctLabels = (labels: string[]): string => Array.from(new Set(labels)).join('; ');

const isValidLocalDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export const groupMonthlyReportDetailRows = (rows: MonthlyReportRow[]): MonthlyReportDetailRow[] => {
  const groups = new Map<string, MonthlyReportRow[]>();

  rows.forEach((row, index) => {
    const hasPatientId = Boolean(row.patientId?.trim());
    const hasLocalDate = isValidLocalDate(row.date || '');
    const key = hasPatientId && hasLocalDate
      ? `${row.patientId.trim()}|${row.date}`
      : `treatment:${row.treatmentId || index}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  });

  return Array.from(groups.values()).map(group => {
    const sortedGroup = [...group].sort((a, b) => a.treatmentId.localeCompare(b.treatmentId));
    const first = sortedGroup[0];
    const sum = (selector: (row: MonthlyReportRow) => number) => money(sortedGroup.reduce((total, row) => total + selector(row), 0));
    const cost = sum(row => row.cost);
    const standardCost = sum(row => row.standardCost);
    const discount = sum(row => row.discount);
    const payment = sum(row => row.payment);
    const balance = sum(row => row.balance);
    const serviceCharges = sum(row => row.serviceCharges);
    const medicineSales = sum(row => row.medicineSales);
    const totalRevenue = sum(row => row.totalRevenue);
    const labCost = sum(row => row.labCost);
    const materialCost = sum(row => row.materialCost);
    const specialDoctorCost = sum(row => row.specialDoctorCost);
    const mlsTotal = sum(row => row.mlsTotal);
    const doctorCost = sum(row => row.doctorCost);
    const totalCost = sum(row => row.totalCost);
    const netProfit = sum(row => row.netProfit);

    return {
      ...first,
      treatmentId: sortedGroup.map(row => row.treatmentId).join('|'),
      treatmentIds: sortedGroup.map(row => row.treatmentId),
      treatmentCount: sortedGroup.length,
      treatment: combineLabels(sortedGroup.map(row => row.treatment)),
      doctor: combineDistinctLabels(sortedGroup.map(row => row.doctor)),
      standardCost,
      discount,
      cost,
      payment,
      balance,
      serviceCharges,
      medicineSales,
      totalRevenue,
      labCost,
      materialCost,
      specialDoctorCost,
      mlsTotal,
      doctorCost,
      totalCost,
      netProfit,
      netMargin: totalRevenue > 0 ? netProfit / totalRevenue : 0
    };
  }).sort((a, b) => (
    a.date.localeCompare(b.date)
    || a.patientName.localeCompare(b.patientName)
    || a.patientId.localeCompare(b.patientId)
    || a.treatmentIds[0].localeCompare(b.treatmentIds[0])
  ));
};

const buildPaymentByTreatment = (
  records: MonthlyReportSourceRecord[],
  payments: PaymentRecord[],
  countedPaymentIds?: Set<string>
): Map<string, number> => {
  const uniquePayments = dedupePaymentRecords(payments).filter((payment) => !payment.voidedAt);
  const allocations = allocateCommissionablePayments(
    records.map(record => ({
      id: record.id,
      patientId: record.patient_id,
      date: record.date,
      cost: positiveMoney(record.cost)
    })),
    uniquePayments.map(payment => ({
      id: payment.id,
      patientId: payment.patientId,
      date: payment.date,
      createdAt: payment.createdAt,
      commissionableAmount: getPaymentTreatmentShare(payment),
      treatmentIds: getPaymentTreatmentIds(payment)
    }))
  );

  return allocations.reduce((map, allocation) => {
    // Payments outside the report period are still part of the FIFO allocation
    // (they consume older balances), but only in-period receipts may count as
    // this period's collections.
    if (countedPaymentIds && !countedPaymentIds.has(allocation.paymentId)) return map;
    map.set(allocation.treatmentId, money((map.get(allocation.treatmentId) || 0) + allocation.amount));
    return map;
  }, new Map<string, number>());
};

type AllocatedTreatmentCosts = Pick<TreatmentCostSummary, 'materialTotal' | 'labTotal' | 'specialDoctorTotal'>;

const allocatePaymentCostsByTreatment = (
  records: MonthlyReportSourceRecord[],
  payments: PaymentRecord[],
  paymentCostSummaries: Record<string, TreatmentCostSummary>
): Map<string, AllocatedTreatmentCosts> => {
  const recordById = new Map(records.map((record) => [record.id, record]));
  const activePayments = dedupePaymentRecords(payments).filter((payment) => !payment.voidedAt);
  const allocations = allocateCommissionablePayments(
    records.map((record) => ({
      id: record.id,
      patientId: record.patient_id,
      date: record.date,
      cost: positiveMoney(record.cost)
    })),
    activePayments.map((payment) => ({
      id: payment.id,
      patientId: payment.patientId,
      date: payment.date,
      createdAt: payment.createdAt,
      commissionableAmount: getPaymentTreatmentShare(payment),
      treatmentIds: getPaymentTreatmentIds(payment)
    }))
  );
  const allocatedTreatmentIdsByPayment = new Map<string, string[]>();
  allocations.forEach((allocation) => {
    const ids = allocatedTreatmentIdsByPayment.get(allocation.paymentId) || [];
    if (!ids.includes(allocation.treatmentId)) ids.push(allocation.treatmentId);
    allocatedTreatmentIdsByPayment.set(allocation.paymentId, ids);
  });

  const result = new Map<string, AllocatedTreatmentCosts>();
  activePayments.forEach((payment) => {
    const summary = paymentCostSummaries[payment.id];
    if (!summary || positiveMoney(summary.totalAmount) <= 0) return;
    const allocatedIds = allocatedTreatmentIdsByPayment.get(payment.id) || [];
    const explicitIds = getPaymentTreatmentIds(payment).filter((id) => recordById.has(id));
    const treatmentIds = allocatedIds.length > 0 ? allocatedIds : explicitIds;
    if (treatmentIds.length === 0) return;

    const totalWeight = treatmentIds.reduce(
      (sum, id) => sum + positiveMoney(recordById.get(id)?.cost),
      0
    );
    let allocatedMaterial = 0;
    let allocatedLab = 0;
    let allocatedSpecialDoctor = 0;
    treatmentIds.forEach((id, index) => {
      const isLast = index === treatmentIds.length - 1;
      const weight = totalWeight > 0
        ? positiveMoney(recordById.get(id)?.cost) / totalWeight
        : 1 / treatmentIds.length;
      const materialTotal = isLast
        ? money(positiveMoney(summary.materialTotal) - allocatedMaterial)
        : money(positiveMoney(summary.materialTotal) * weight);
      const labTotal = isLast
        ? money(positiveMoney(summary.labTotal) - allocatedLab)
        : money(positiveMoney(summary.labTotal) * weight);
      const specialDoctorTotal = isLast
        ? money(positiveMoney(summary.specialDoctorTotal) - allocatedSpecialDoctor)
        : money(positiveMoney(summary.specialDoctorTotal) * weight);
      allocatedMaterial = money(allocatedMaterial + materialTotal);
      allocatedLab = money(allocatedLab + labTotal);
      allocatedSpecialDoctor = money(allocatedSpecialDoctor + specialDoctorTotal);
      const current = result.get(id) || { materialTotal: 0, labTotal: 0, specialDoctorTotal: 0 };
      result.set(id, {
        materialTotal: money(current.materialTotal + materialTotal),
        labTotal: money(current.labTotal + labTotal),
        specialDoctorTotal: money(current.specialDoctorTotal + specialDoctorTotal)
      });
    });
  });
  return result;
};

const summarizeRows = (rows: MonthlyReportRow[], operatingExpenses = 0, unassignedServiceCharges = 0, unassignedMedicineSales = 0): Omit<MonthlyReportSummary, 'balanceCollections' | 'collectedReceipts'> => {
  const total = (selector: (row: MonthlyReportRow) => number) => money(rows.reduce((sum, row) => sum + selector(row), 0));
  const production = total(row => row.cost);
  const payment = total(row => row.payment);
  const serviceCharges = money(total(row => row.serviceCharges) + unassignedServiceCharges);
  const medicineSales = money(total(row => row.medicineSales) + unassignedMedicineSales);
  const totalRevenue = money(production + serviceCharges + medicineSales);
  const directCost = total(row => row.totalCost);
  const totalCost = money(directCost + operatingExpenses);
  const netProfit = money(totalRevenue - totalCost);
  return {
    treatmentCount: rows.length,
    patientCount: new Set(rows.map(row => row.patientId).filter(Boolean)).size,
    standardProduction: total(row => row.standardCost),
    discount: total(row => row.discount),
    production,
    payment,
    balance: total(row => row.balance),
    serviceCharges,
    medicineSales,
    totalRevenue,
    labCost: total(row => row.labCost),
    materialCost: total(row => row.materialCost),
    specialDoctorCost: total(row => row.specialDoctorCost),
    mlsTotal: total(row => row.mlsTotal),
    doctorCost: total(row => row.doctorCost),
    operatingExpenses: money(operatingExpenses),
    totalCost,
    netProfit,
    netMargin: totalRevenue > 0 ? netProfit / totalRevenue : 0,
    collectionRate: production > 0 ? payment / production : 0
  };
};

const groupRows = (rows: MonthlyReportRow[], key: (row: MonthlyReportRow) => string): MonthlyReportGroup[] => {
  const groups = new Map<string, MonthlyReportRow[]>();
  rows.forEach(row => {
    const name = key(row) || 'Not recorded';
    groups.set(name, [...(groups.get(name) || []), row]);
  });
  return Array.from(groups, ([name, group]) => {
    const summary = summarizeRows(group);
    return {
      name,
      treatments: summary.treatmentCount,
      patients: summary.patientCount,
      discount: summary.discount,
      production: summary.production,
      payment: summary.payment,
      serviceCharges: summary.serviceCharges,
      medicineSales: summary.medicineSales,
      totalRevenue: summary.totalRevenue,
      mlsTotal: summary.mlsTotal,
      doctorCost: summary.doctorCost,
      totalCost: summary.totalCost,
      netProfit: summary.netProfit,
      netMargin: summary.netMargin
    };
  }).sort((a, b) => b.production - a.production || a.name.localeCompare(b.name));
};

const appendUnassignedRevenueGroups = (
  groups: MonthlyReportGroup[],
  unassignedServiceCharges: number,
  unassignedServicePatients: number,
  unassignedMedicineSales: number,
  unassignedMedicinePatients: number
): MonthlyReportGroup[] => {
  const result = [...groups];
  if (unassignedServiceCharges > 0) {
    result.push({
      name: 'Service fee only / No treatment',
      treatments: 0,
      patients: unassignedServicePatients,
      discount: 0,
      production: 0,
      payment: 0,
      serviceCharges: unassignedServiceCharges,
      medicineSales: 0,
      totalRevenue: unassignedServiceCharges,
      mlsTotal: 0,
      doctorCost: 0,
      totalCost: 0,
      netProfit: unassignedServiceCharges,
      netMargin: 1
    });
  }
  if (unassignedMedicineSales > 0) {
    result.push({
      name: 'Medicine sale only / No treatment',
      treatments: 0,
      patients: unassignedMedicinePatients,
      discount: 0,
      production: 0,
      payment: 0,
      serviceCharges: 0,
      medicineSales: unassignedMedicineSales,
      totalRevenue: unassignedMedicineSales,
      mlsTotal: 0,
      doctorCost: 0,
      totalCost: 0,
      netProfit: unassignedMedicineSales,
      netMargin: 1
    });
  }
  return result;
};

const isInsideReportPeriod = (date: string, dateFrom?: string, dateTo?: string): boolean => (
  (!dateFrom || !date || date >= dateFrom) && (!dateTo || !date || date <= dateTo)
);

// The report Payments table is taken from the Audit Log → Payments tab, not from
// a second calculation of its own. `buildAuditLogRows` is the builder the Records
// page renders, so the receipts listed here, the recorded date/time they show and
// the doctor commission attached to each one are the same values as that tab.
//
// The data layer also loads the stored commission ledger total of every receipt.
// That stored total is exactly what the tab shows, so it wins over the row
// builder's inference, which can only see the report's own patient history.
const buildReportPayments = (
  records: MonthlyReportSourceRecord[],
  appointments: Appointment[],
  payments: PaymentRecord[],
  dateFrom?: string,
  dateTo?: string
): MonthlyReportPayment[] => {
  const storedDoctorEarnings = new Map<string, number>();
  payments.forEach((payment) => {
    if (typeof payment.doctorEarned === 'number') storedDoctorEarnings.set(payment.id, payment.doctorEarned);
  });

  return buildAuditLogRows(records, appointments, true, payments)
    .filter((row): row is Extract<AuditExportRow, { kind: 'payment' }> => row.kind === 'payment')
    // The Audit Log filters payments on the same date value it displays, so the
    // report lists exactly the receipts the tab shows for this period.
    .filter((row) => isInsideReportPeriod(getAuditLogEventDate(row), dateFrom, dateTo))
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate)
      || (a.payment.receiptNumber || '').localeCompare(b.payment.receiptNumber || '')
      || a.payment.id.localeCompare(b.payment.id))
    .map((row) => ({
      ...row.payment,
      // A voided receipt earned no commission, so it is listed without earnings.
      doctorEarned: row.payment.voidedAt
        ? 0
        : storedDoctorEarnings.get(row.payment.id) ?? row.payment.doctorEarned ?? 0
    }));
};

export const buildMonthlyReport = (data: MonthlyReportData): MonthlyReport => {
  // An explicitly empty ledger is authoritative too. Never allocate these costs
  // through treatments: their expense period can differ from production.
  if (data.costItems !== undefined) {
    const report = buildMonthlyReport({ ...data, costItems: undefined, costSummaries: {}, paymentCostSummaries: {} });
    report.costItems = data.costItems.filter(item => isValidLocalDate(item.expenseDate)
      && (!data.dateFrom || item.expenseDate >= data.dateFrom)
      && (!data.dateTo || item.expenseDate <= data.dateTo))
      .map(item => ({ ...item, amount: positiveMoney(item.amount) }));
    for (const item of report.costItems) {
      const field = item.costType === 'material' ? 'materialCost' : item.costType === 'lab' ? 'labCost' : 'specialDoctorCost';
      report.summary[field] = money(report.summary[field] + item.amount);
      report.summary.mlsTotal = money(report.summary.mlsTotal + item.amount);
      report.summary.totalCost = money(report.summary.totalCost + item.amount);
      for (const [groups, label] of [[report.byTreatment, item.treatmentLabel], [report.byDoctor, item.doctorName],
        [report.byPatientType, item.patientType]] as [MonthlyReportGroup[], string][]) {
        const name = label.trim() || 'Not recorded';
        let group = groups.find(candidate => candidate.name === name);
        if (!group) {
          group = { name, treatments: 0, patients: 0, discount: 0, production: 0, payment: 0,
            serviceCharges: 0, medicineSales: 0, totalRevenue: 0, mlsTotal: 0, doctorCost: 0,
            totalCost: 0, netProfit: 0, netMargin: 0 };
          groups.push(group);
        }
        group.mlsTotal = money(group.mlsTotal + item.amount);
        group.totalCost = money(group.totalCost + item.amount);
        group.netProfit = money(group.totalRevenue - group.totalCost);
        group.netMargin = group.totalRevenue > 0 ? group.netProfit / group.totalRevenue : 0;
      }
    }
    report.summary.netProfit = money(report.summary.totalRevenue - report.summary.totalCost);
    report.summary.netMargin = report.summary.totalRevenue > 0 ? report.summary.netProfit / report.summary.totalRevenue : 0;
    return report;
  }
  const allocationRecords = data.allocationRecords || data.records;
  // The Payments table of the report mirrors the Audit Log → Payments tab:
  // the same receipts, the same recorded date/time and the same doctor
  // commission per receipt. Only receipts shown on that tab for this period are
  // listed, while every receipt (including the older ones) still takes part in
  // the FIFO allocation so remaining balances stay correct.
  const reportPayments = buildReportPayments(
    allocationRecords,
    data.appointments || [],
    data.payments,
    data.dateFrom,
    data.dateTo
  );
  const reportPaymentIds = new Set(reportPayments.map((payment) => payment.id));
  const paymentByTreatment = buildPaymentByTreatment(allocationRecords, data.payments, reportPaymentIds);
  const paymentCostsByTreatment = allocatePaymentCostsByTreatment(
    allocationRecords,
    data.payments,
    data.paymentCostSummaries || {}
  );
  const recordById = new Map(data.records.map(record => [record.id, record]));
  const firstTreatmentByVisit = new Map<string, string>();
  data.records.forEach((record) => {
    const visitKey = `${record.patient_id}|${record.date}`;
    if (!firstTreatmentByVisit.has(visitKey)) firstTreatmentByVisit.set(visitKey, record.id);
  });
  const serviceChargesByTreatment = new Map<string, number>();
  const paymentFeeVisits = new Set<string>();
  const unassignedServiceChargesByVisit = new Map<string, number>();
  const unassignedServicePatientIds = new Set<string>();
  const reportDateFrom = data.dateFrom || data.records.reduce((earliest, record) => !earliest || record.date < earliest ? record.date : earliest, '');
  const reportDateTo = data.dateTo || data.records.reduce((latest, record) => !latest || record.date > latest ? record.date : latest, '');
  const isInReportRange = (date: string) => (
    (!reportDateFrom || date >= reportDateFrom) && (!reportDateTo || date <= reportDateTo)
  );
  dedupePaymentRecords(data.payments).filter((payment) => !payment.voidedAt).forEach((payment) => {
    const amount = positiveMoney(getPaymentServiceFeeAmount(payment));
    if (amount <= 0 || !isInReportRange(payment.date || '')) return;

    const linkedTreatmentId = getPaymentTreatmentIds(payment).find((treatmentId) => recordById.has(treatmentId));
    const visitKey = `${payment.patientId}|${payment.date}`;
    const treatmentId = linkedTreatmentId || firstTreatmentByVisit.get(visitKey);
    paymentFeeVisits.add(visitKey);
    if (!treatmentId) {
      unassignedServiceChargesByVisit.set(
        visitKey,
        Math.max(unassignedServiceChargesByVisit.get(visitKey) || 0, amount)
      );
      if (payment.patientId) unassignedServicePatientIds.add(payment.patientId);
      return;
    }

    // The receipt snapshot can be repeated on partial or retried payments for
    // the same visit. A service fee is a per-visit charge, so keep the largest
    // recorded amount instead of adding duplicate snapshots together.
    serviceChargesByTreatment.set(
      treatmentId,
      Math.max(serviceChargesByTreatment.get(treatmentId) || 0, amount)
    );
    const treatment = recordById.get(treatmentId);
    if (treatment) paymentFeeVisits.add(`${treatment.patient_id}|${treatment.date}`);
  });
  (data.appointments || []).forEach((appointment) => {
    if (appointment.clinical_fee_status !== 'APPLIED') return;
    const amount = positiveMoney(appointment.clinical_fee_amount);
    if (amount <= 0) return;
    const visitKey = `${appointment.patient_id || ''}|${appointment.date || ''}`;
    if (paymentFeeVisits.has(visitKey)) return;
    const treatmentId = firstTreatmentByVisit.get(visitKey);
    if (treatmentId) {
      serviceChargesByTreatment.set(
        treatmentId,
        Math.max(serviceChargesByTreatment.get(treatmentId) || 0, amount)
      );
    } else {
      unassignedServiceChargesByVisit.set(
        visitKey,
        Math.max(unassignedServiceChargesByVisit.get(visitKey) || 0, amount)
      );
      if (appointment.patient_id) unassignedServicePatientIds.add(appointment.patient_id);
    }
  });
  const unassignedServiceCharges = money(
    Array.from(unassignedServiceChargesByVisit.values()).reduce((sum, amount) => sum + amount, 0)
  );
  const medicineSalesByTreatment = new Map<string, number>();
  let unassignedMedicineSales = 0;
  const unassignedMedicinePatientIds = new Set<string>();
  (data.medicineSales || []).forEach((sale) => {
    const amount = positiveMoney(sale.total_price);
    if (amount <= 0) return;
    const treatmentId = sale.treatment_id && recordById.has(sale.treatment_id)
      ? sale.treatment_id
      : firstTreatmentByVisit.get(`${sale.patient_id}|${sale.date}`);
    if (treatmentId) medicineSalesByTreatment.set(treatmentId, money((medicineSalesByTreatment.get(treatmentId) || 0) + amount));
    else {
      unassignedMedicineSales = money(unassignedMedicineSales + amount);
      if (sale.patient_id) unassignedMedicinePatientIds.add(sale.patient_id);
    }
  });
  const operatingExpenses = (data.expenses || []).reduce((sum, expense) => sum + positiveMoney(expense.amount), 0);
  const currentBalanceOwnerByPatient = new Map<string, string>();
  data.records.forEach((record) => {
    if (!record.patient_id || record.patient_balance === null || record.patient_balance === undefined) return;
    const currentOwnerId = currentBalanceOwnerByPatient.get(record.patient_id);
    const currentOwner = currentOwnerId ? recordById.get(currentOwnerId) : undefined;
    if (!currentOwner || record.date > currentOwner.date || (record.date === currentOwner.date && record.id > currentOwner.id)) {
      currentBalanceOwnerByPatient.set(record.patient_id, record.id);
    }
  });
  const rows = data.records.map((record): MonthlyReportRow => {
    const cost = positiveMoney(record.cost);
    const explicitDiscount = positiveMoney(record.discountAmount);
    const standardCost = Math.max(cost, positiveMoney(record.standardCost), money(cost + explicitDiscount));
    const discount = money(Math.max(explicitDiscount, standardCost - cost));
    const payment = Math.min(cost, positiveMoney(paymentByTreatment.get(record.id)));
    const allocatedTreatmentBalance = money(Math.max(0, cost - payment));
    const hasAuthoritativePatientBalance = record.patient_balance !== null && record.patient_balance !== undefined;
    const balance = hasAuthoritativePatientBalance
      ? currentBalanceOwnerByPatient.get(record.patient_id) === record.id
        ? positiveMoney(record.patient_balance)
        : 0
      : allocatedTreatmentBalance;
    const serviceCharges = positiveMoney(serviceChargesByTreatment.get(record.id));
    const medicineSales = positiveMoney(medicineSalesByTreatment.get(record.id));
    const totalRevenue = money(cost + serviceCharges + medicineSales);
    const costs = data.costSummaries[record.id];
    const paymentCosts = paymentCostsByTreatment.get(record.id);
    const labCost = money(positiveMoney(costs?.labTotal) + positiveMoney(paymentCosts?.labTotal));
    const materialCost = money(positiveMoney(costs?.materialTotal) + positiveMoney(paymentCosts?.materialTotal));
    const specialDoctorCost = money(positiveMoney(costs?.specialDoctorTotal) + positiveMoney(paymentCosts?.specialDoctorTotal));
    const mlsTotal = money(materialCost + labCost + specialDoctorCost);
    const doctorCost = positiveMoney(record.doctorEarnings);
    const totalCost = money(mlsTotal + doctorCost);
    const netProfit = money(totalRevenue - totalCost);
    return {
      treatmentId: record.id,
      date: record.date,
      patientId: record.patient_id,
      patientName: record.patient_name?.trim() || 'Unknown patient',
      age: record.patient_age !== null && record.patient_age !== undefined && Number.isFinite(Number(record.patient_age))
        ? Number(record.patient_age)
        : null,
      phone: record.patient_phone?.trim() || 'Not recorded',
      city: record.patient_city?.trim() || 'Not recorded',
      township: record.patient_township?.trim() || 'Not recorded',
      patientType: record.patient_type?.trim() || 'Not assigned',
      treatment: record.description?.trim() || 'Treatment',
      doctor: record.doctor_name?.trim() || 'Unassigned',
      standardCost,
      discount,
      cost,
      payment,
      balance,
      serviceCharges,
      medicineSales,
      totalRevenue,
      labCost,
      materialCost,
      specialDoctorCost,
      mlsTotal,
      doctorCost,
      totalCost,
      netProfit,
      netMargin: totalRevenue > 0 ? netProfit / totalRevenue : 0
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.patientName.localeCompare(b.patientName) || a.treatmentId.localeCompare(b.treatmentId));

  // Collections applied to treatments dated before the report period (previous
  // debt). `paymentByTreatment` is keyed by treatment id; any id that is not in
  // the in-period `rows` set was allocated to older debt.
  const balanceCollections = money(
    Array.from(paymentByTreatment.entries())
      .filter(([treatmentId]) => !recordById.has(treatmentId))
      .reduce((sum, [, amount]) => sum + amount, 0)
  );
  const collectedReceipts = money(
    reportPayments
      .filter((payment) => !payment.voidedAt)
      .reduce((sum, payment) => sum + positiveMoney(payment.amount), 0)
  );

  return {
    rows,
    summary: {
      ...summarizeRows(rows, operatingExpenses, unassignedServiceCharges, unassignedMedicineSales),
      balanceCollections,
      collectedReceipts
    },
    byTreatment: appendUnassignedRevenueGroups(
      groupRows(rows, row => row.treatment),
      unassignedServiceCharges,
      unassignedServicePatientIds.size,
      unassignedMedicineSales,
      unassignedMedicinePatientIds.size
    ),
    byDoctor: appendUnassignedRevenueGroups(
      groupRows(rows, row => row.doctor),
      unassignedServiceCharges,
      unassignedServicePatientIds.size,
      unassignedMedicineSales,
      unassignedMedicinePatientIds.size
    ),
    byPatientType: appendUnassignedRevenueGroups(
      groupRows(rows, row => row.patientType),
      unassignedServiceCharges,
      unassignedServicePatientIds.size,
      unassignedMedicineSales,
      unassignedMedicinePatientIds.size
    ),
    expenses: data.expenses || [],
    // Already Audit Log payment rows, so every listed receipt carries the
    // commission amount the Payment Log shows for it.
    payments: reportPayments
  };
};

export const monthlyReportFilename = (metadata: MonthlyReportMetadata, extension: 'pdf' | 'xlsx'): string => {
  const scope = metadata.locationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
  return `monthly-report-${metadata.dateFrom}-to-${metadata.dateTo}-${scope}.${extension}`;
};
