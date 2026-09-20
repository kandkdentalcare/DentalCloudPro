import type { ClinicalRecord, PaymentRecord } from '../types';
import { allocateCommissionablePayments } from './doctorCommissionLedger';
import {
  dedupePaymentRecords,
  getPaymentTreatmentIds,
  getPaymentTreatmentShare
} from './paymentTreatmentAllocation';

export interface MaterialPaymentHistoryRow {
  id: string;
  payment: PaymentRecord;
  date: string;
  sortDate: string;
  receiptNumber: string;
  patientId: string;
  patientName: string;
  patientUniqueId: string;
  doctorNames: string[];
  treatmentNames: string[];
  treatmentIds: string[];
  totalPaid: number;
  appliedToTreatment: number;
  balanceAfter: number;
  doctorEarned: number;
}

const roundMoney = (amount: number): number => Math.round(amount * 100) / 100;
const money = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

/** Builds one row per real collection. It intentionally never groups payments by patient or treatment. */
export const buildMaterialPaymentHistoryRows = (
  records: ClinicalRecord[],
  payments: PaymentRecord[]
): MaterialPaymentHistoryRow[] => {
  const activePayments = dedupePaymentRecords(payments.filter((payment) => !payment.voidedAt));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const recordsByPatient = new Map<string, ClinicalRecord[]>();
  records.forEach((record) => {
    const patientRecords = recordsByPatient.get(record.patient_id) || [];
    patientRecords.push(record);
    recordsByPatient.set(record.patient_id, patientRecords);
  });

  const allocations = allocateCommissionablePayments(
    records.map((record) => ({
      id: record.id,
      patientId: record.patient_id,
      date: record.date,
      cost: money(record.cost)
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

  const allocationsByPayment = new Map<string, typeof allocations>();
  allocations.forEach((allocation) => {
    const rows = allocationsByPayment.get(allocation.paymentId) || [];
    rows.push(allocation);
    allocationsByPayment.set(allocation.paymentId, rows);
  });

  return activePayments.map((payment) => {
    const paymentAllocations = allocationsByPayment.get(payment.id) || [];
    const allocatedTreatmentIds = Array.from(new Set(paymentAllocations.map((item) => item.treatmentId)));
    const linkedTreatmentIds = allocatedTreatmentIds.length > 0
      ? allocatedTreatmentIds
      : getPaymentTreatmentIds(payment);
    const linkedRecords = linkedTreatmentIds
      .map((id) => recordById.get(id))
      .filter((record): record is ClinicalRecord => !!record);
    const snapshotTreatmentNames = (payment.receiptSnapshot?.treatments || [])
      .map((item) => item.description)
      .filter(Boolean);
    const treatmentNames = Array.from(new Set([
      ...linkedRecords.map((record) => record.description).filter(Boolean),
      ...(linkedRecords.length === 0 ? snapshotTreatmentNames : [])
    ]));
    const doctorNames = Array.from(new Set(
      linkedRecords.map((record) => record.doctor_name || '').filter(Boolean)
    ));
    const patientRecords = recordsByPatient.get(payment.patientId) || [];
    const paymentLedgerEntries = records.flatMap((record) => (
      (record.doctorEarningEntries || []).filter((entry) => entry.paymentId === payment.id)
    ));
    const ledgerDoctorEarned = paymentLedgerEntries.reduce((sum, entry) => sum + money(entry.earnings), 0);
    const appliedToTreatment = paymentAllocations.reduce((sum, allocation) => sum + money(allocation.amount), 0);

    return {
      id: payment.id,
      payment,
      date: payment.date || payment.createdAt?.slice(0, 10) || '',
      sortDate: payment.createdAt || payment.date || '',
      receiptNumber: payment.receiptNumber || payment.receiptSnapshot?.receiptNumber || '—',
      patientId: payment.patientId,
      patientName: payment.patient_name || payment.receiptSnapshot?.patient.name || patientRecords[0]?.patient_name || 'Unknown',
      patientUniqueId: payment.receiptSnapshot?.patient.patientUniqueId || patientRecords[0]?.patient_unique_id || payment.patientId,
      doctorNames,
      treatmentNames,
      treatmentIds: linkedTreatmentIds,
      totalPaid: money(payment.clearedAmount ?? payment.amount),
      appliedToTreatment: roundMoney(appliedToTreatment),
      balanceAfter: money(payment.receiptSnapshot?.payment.balanceAfter ?? payment.remainingBalance),
      doctorEarned: roundMoney(paymentLedgerEntries.length > 0 ? ledgerDoctorEarned : money(payment.doctorEarned))
    };
  }).sort((a, b) => b.sortDate.localeCompare(a.sortDate) || b.id.localeCompare(a.id));
};

export interface MaterialPaymentHistoryFilters {
  dateFrom: string;
  dateTo: string;
  patientSearchTerm: string;
  doctorSearchTerm: string;
  treatmentSearchTerm: string;
}

export const filterMaterialPaymentHistoryRows = (
  rows: MaterialPaymentHistoryRow[],
  filters: MaterialPaymentHistoryFilters
): MaterialPaymentHistoryRow[] => {
  const patientTerm = filters.patientSearchTerm.trim().toLowerCase();
  const doctorTerm = filters.doctorSearchTerm.trim().toLowerCase();
  const treatmentTerm = filters.treatmentSearchTerm.trim().toLowerCase();

  return rows.filter((row) => {
    const date = row.date.slice(0, 10);
    if (filters.dateFrom && date < filters.dateFrom) return false;
    if (filters.dateTo && date > filters.dateTo) return false;
    if (patientTerm && ![row.patientName, row.patientUniqueId, row.patientId]
      .some((value) => value.toLowerCase().includes(patientTerm))) return false;
    if (doctorTerm && !row.doctorNames.some((name) => name.toLowerCase().includes(doctorTerm))) return false;
    if (treatmentTerm && !row.treatmentNames.some((name) => name.toLowerCase().includes(treatmentTerm))) return false;
    return true;
  });
};
