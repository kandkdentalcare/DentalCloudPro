import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';
import * as tus from 'tus-js-client';
import { Patient, Appointment, AppointmentRescheduleLog, ClinicalRecord, TreatmentType, PatientFile, Doctor, DoctorSchedule, DoctorScheduleInput, User, Medicine, MedicineSale, Location, LoyaltyRule, LoyaltyTransaction, Expense, Message, Conversation, ScheduledTask, S3Settings, PatientType, AppointmentType, DoctorTreatmentCommission, PaymentMethod, PaymentRecord, PaymentReceiptSnapshot, ReceiptPreferences, ClinicalFeeSettings, ClinicalFeeCompletionResult, ActiveStaffMonitorEntry, PaymentCorrection, PaymentAllocation, AuditLogSourceType, PatientMaterialCost, PatientMaterialCostInput, TreatmentCostSummary, TreatmentCostType, MaterialLabCostPreset, MaterialLabCostPresetInput, CancellationOutcome, DoctorCorrectionPreview, DoctorCorrectionResult } from '../types';
import { AUTO_ONP_PATIENT_TYPE_NAME, DEFAULT_PATIENT_TYPE_NAME, DEFAULT_PATIENT_TYPE_OPTIONS, DOCTOR_DASHBOARD_TABS, FULL_ACCESS_TAB_PERMISSIONS } from '../constants';
import { resolveAllowedTabs } from '../utils/permissions';
import { EmailSettings, loadEmailSettingsAsync, saveEmailSettingsAsync } from '../utils/emailSettings';
import { buildS3FileUrl, buildSupabaseS3Url, buildSupabaseS3PublicUrl, deleteS3Object, isSupabaseS3Endpoint, isS3SettingsReady, listS3Objects, normalizeS3BaseUrl, uploadS3Object } from '../utils/s3Storage';
import { buildSupabasePublicUrl, deleteSupabaseStorageFile, isSupabaseStorageReady, listSupabaseStorageFiles, normalizeSupabaseStorageUrl, uploadSupabaseStorageFile } from '../utils/supabaseStorage';
import { findInvalidTeeth } from '../utils/toothNumbering';
import { getPaymentHeaderMethod, normalizePaymentAllocations, normalizePaymentMethod, validatePaymentAllocations } from '../utils/paymentMethods';
import { normalizePaymentReceiptSnapshot } from '../utils/paymentReceipt';
import { getPaymentAvailableTreatmentAmount, getPaymentTreatmentShare } from '../utils/paymentTreatmentAllocation';
import { DEFAULT_RECEIPT_PREFERENCES, normalizeReceiptPreferences } from '../utils/receiptPreferences';
import { resolveDoctorCommissionType, usesFlatVisitCommission, validateDoctorCommissionPercentage, validateDoctorCommissionPerVisit, validateDoctorCommissionType } from '../utils/doctorCommission';
import { allocateCommissionablePayments, calculateCommissionLedgerEntries } from '../utils/doctorCommissionLedger';
import { enumValue, finiteNumber, strictDateString, trimOptional, trimRequired } from '../utils/validation';
import { buildPatientCreatedAt } from '../utils/patientCreationDate';
import { summarizeTreatmentCostRows } from '../utils/treatmentCostSummaries';
import { buildPatientProfileUpdatePayload } from '../utils/patientProfileUpdate';
import { chunkMonthlyReportPatientIds, type MonthlyReportSourceRecord } from '../utils/monthlyReport';
import { chunkUniqueIds, mapWithConcurrency, REPORT_REQUEST_CONCURRENCY } from '../utils/reportBatching';
import { normalizeMaterialCostPresetInputs, sortMaterialCostPresets } from '../utils/materialCostPresets';
import { buildDoctorDirectWritePayload } from '../utils/doctorWritePayload';
import { excludeProtectedDoctorChange } from '../utils/appointmentDoctorUpdate';
import { getPatientAuthConflictMessage } from '../utils/patientAuthConflict';

let usersAllowedTabsSupport: boolean | null = null;
let usersDoctorIdSupport: boolean | null = null;
let doctorLocationsSupport: boolean | null = null;
let conversationsDoctorUserSupport: boolean | null = null;
let storageConfigVersion = 0;

const MEDICINE_ITEM_TYPES = ['Medicine', 'Retail', 'Supply', 'Other'] as const;
const SUPABASE_PAGE_SIZE = 1000;

const fetchAllRows = async <T,>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<{ data: T[] | null; error: any }> => {
  const rows: T[] = [];
  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const result = await buildQuery(from, from + SUPABASE_PAGE_SIZE - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data || [];
    rows.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) return { data: rows, error: null };
  }
};

const isMissingColumnError = (error: any, columnName: string): boolean => {
  return typeof error?.message === 'string' && error.message.toLowerCase().includes(columnName.toLowerCase());
};

const buildExpensePayload = (data: Partial<Expense>, existing?: Partial<Expense>): Partial<Expense> => {
  const payload: Partial<Expense> = {};

  if (data.location_id !== undefined) {
    payload.location_id = trimRequired(data.location_id, 'Location');
  } else if (!existing) {
    payload.location_id = trimRequired(data.location_id, 'Location');
  }

  if (data.description !== undefined) {
    payload.description = trimRequired(data.description, 'Expense description', { maxLength: 500 });
  } else if (!existing) {
    payload.description = trimRequired(data.description, 'Expense description', { maxLength: 500 });
  }

  if (data.amount !== undefined) {
    payload.amount = finiteNumber(data.amount, 'Expense amount', { min: 0.01 });
  } else if (!existing) {
    payload.amount = finiteNumber(data.amount, 'Expense amount', { min: 0.01 });
  }

  if (data.category !== undefined) {
    payload.category = trimRequired(data.category, 'Expense category', { maxLength: 100 });
  } else if (!existing) {
    payload.category = trimRequired(data.category, 'Expense category', { maxLength: 100 });
  }

  if (data.date !== undefined) {
    payload.date = strictDateString(data.date, 'Expense date');
  } else if (!existing) {
    payload.date = strictDateString(data.date, 'Expense date');
  }

  return payload;
};

const getTreatmentCostExpenseMetadata = (costType: TreatmentCostType) => {
  if (costType === 'lab') return { category: 'Lab Cost', sourceType: 'lab_cost', label: 'Lab cost' };
  if (costType === 'special_doctor') return { category: 'Special Doctor Cost', sourceType: 'special_doctor_cost', label: 'Special doctor cost' };
  return { category: 'Material Cost', sourceType: 'material_cost', label: 'Material cost' };
};

const buildTreatmentCostExpenseDescription = (
  treatment: Partial<ClinicalRecord>,
  itemNames: string,
  costType: TreatmentCostType
): string => {
  const patientName = (treatment.patient_name || 'Unknown patient').trim();
  const treatmentLabel = (treatment.description || 'Treatment').trim();
  const itemsLabel = itemNames.trim();
  return `${getTreatmentCostExpenseMetadata(costType).label} - ${patientName} - ${treatmentLabel}${itemsLabel ? ` (${itemsLabel})` : ''}`;
};

const buildTreatmentCostExpensePrefix = (treatment: Partial<ClinicalRecord>, costType: TreatmentCostType): string => {
  const patientName = (treatment.patient_name || 'Unknown patient').trim();
  const treatmentLabel = (treatment.description || 'Treatment').trim();
  return `${getTreatmentCostExpenseMetadata(costType).label} - ${patientName} - ${treatmentLabel}`;
};

const roundMoney = (amount: number): number => Math.round(amount * 100) / 100;

const generateRequestUuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

const getPaymentCommissionableAmount = (payment: any): number => {
  const receiptSnapshot = normalizePaymentReceiptSnapshot(payment.receipt_snapshot);
  return getPaymentTreatmentShare({
    id: String(payment.id || ''),
    patientId: String(payment.patient_id || ''),
    amount: Math.max(0, Number(payment.amount || 0)),
    clearedAmount: Math.max(0, Number(payment.cleared_amount ?? payment.amount ?? 0)),
    date: String(payment.payment_date || payment.created_at?.slice(0, 10) || ''),
    type: 'PARTIAL',
    remainingBalance: 0,
    receiptSnapshot
  });
};

const getPaymentReceiptTreatmentIds = (payment: any): string[] => {
  const snapshot = normalizePaymentReceiptSnapshot(payment.receipt_snapshot);
  return (snapshot?.treatments || []).map((treatment) => treatment.id).filter(Boolean);
};

// Ledger recalculation runs on every MLS cost save. Writing a patient's full
// ledger back one HTTP request at a time used to dominate that save's runtime,
// so rows are now diffed against storage and only genuine changes are written.
const sameLedgerText = (left: unknown, right: unknown): boolean => {
  const normalize = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    const timestampDate = /^(\d{4}-\d{2}-\d{2})T/.exec(text);
    return timestampDate ? timestampDate[1] : text;
  };
  return normalize(left) === normalize(right);
};

const sameLedgerMoney = (left: unknown, right: unknown): boolean => {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.005;
};

const recalculatePatientDoctorCommissions = async (patientId: string): Promise<void> => {
  let { data: treatmentRows, error: treatmentError }: { data: any[] | null; error: any } = await supabase
    .from('treatments')
    .select('id, location_id, patient_id, doctor_id, treatment_type_id, date, cost, doctor_earnings, commission_type_snapshot, commission_percentage_snapshot, commission_per_visit_snapshot, commission_source_snapshot, commission_snapshot_at, doctors(specialization, commission_type, commission_percentage, commission_per_visit)')
    .eq('patient_id', patientId);

  if (treatmentError && isMissingColumnError(treatmentError, 'commission_type_snapshot')) {
    const fallback = await supabase
      .from('treatments')
      .select('id, location_id, patient_id, doctor_id, treatment_type_id, date, cost, doctors(specialization, commission_type, commission_percentage, commission_per_visit)')
      .eq('patient_id', patientId);
    treatmentRows = fallback.data;
    treatmentError = fallback.error;
  }

  if (treatmentError && isMissingColumnError(treatmentError, 'commission_type')) {
    const fallback = await supabase
      .from('treatments')
      .select('id, location_id, patient_id, doctor_id, treatment_type_id, date, cost, commission_type_snapshot, commission_percentage_snapshot, commission_per_visit_snapshot, commission_source_snapshot, commission_snapshot_at, doctors(specialization, commission_percentage, commission_per_visit)')
      .eq('patient_id', patientId);
    treatmentRows = fallback.data;
    treatmentError = fallback.error;
  }

  if (treatmentError && isMissingColumnError(treatmentError, 'treatment_type_id')) {
    const fallback = await supabase
      .from('treatments')
      .select('id, location_id, patient_id, doctor_id, date, cost, doctor_earnings, commission_type_snapshot, commission_percentage_snapshot, commission_per_visit_snapshot, commission_source_snapshot, commission_snapshot_at, doctors(specialization, commission_type, commission_percentage, commission_per_visit)')
      .eq('patient_id', patientId);
    treatmentRows = (fallback.data || []).map((row: any) => ({ ...row, treatment_type_id: null }));
    treatmentError = fallback.error;
  }
  if (treatmentError) throw new Error(treatmentError.message);
  if (!treatmentRows?.length) return;

  const treatmentIds = treatmentRows.map((row: any) => row.id).filter(Boolean);
  const doctorIds = Array.from(new Set(treatmentRows.map((row: any) => row.doctor_id).filter(Boolean)));
  const [{ data: paymentRows, error: paymentError }, materialByTreatment] = await Promise.all([
    supabase
      .from('payments')
      .select('id, patient_id, payment_date, created_at, amount, cleared_amount, treatment_ids, receipt_snapshot')
      .eq('patient_id', patientId),
    api.materialCosts.getTotalsByTreatmentIds(treatmentIds, { idBatchSize: 50 })
  ]);
  if (paymentError && !isMissingRelationError(paymentError, 'payments')) throw new Error(paymentError.message);

  let customRows: any[] = [];
  if (doctorIds.length > 0) {
    const customResult = await supabase
      .from('doctor_treatment_commissions')
      .select('doctor_id, treatment_id, commission_rate')
      .in('doctor_id', doctorIds);
    if (customResult.error && !isMissingRelationError(customResult.error, 'doctor_treatment_commissions')) {
      throw new Error(customResult.error.message);
    }
    customRows = customResult.data || [];
  }
  const customRateByDoctorAndType = new Map(
    customRows.map((row: any) => [`${row.doctor_id}|${row.treatment_id}`, Number(row.commission_rate || 0)])
  );

  const existingResult = await supabase
    .from('doctor_commission_entries')
    .select('id, payment_id, treatment_id, doctor_id, patient_id, location_id, payment_date, treatment_date, visit_key, calculation_mode, allocated_payment, material_deduction, commission_base, commission_rate, earnings')
    .eq('patient_id', patientId);
  const ledgerInstalled = !existingResult.error;
  if (existingResult.error && !isMissingRelationError(existingResult.error, 'doctor_commission_entries')) {
    throw new Error(existingResult.error.message);
  }

  const treatments = treatmentRows.map((row: any) => ({
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    treatmentTypeId: row.treatment_type_id,
    date: row.date,
    cost: Math.max(0, Number(row.cost || 0)),
    materialCost: materialByTreatment[row.id]?.totalAmount || 0,
    specialDoctorCost: materialByTreatment[row.id]?.specialDoctorTotal || 0,
    commissionType: resolveDoctorCommissionType({
      commissionType: row.commission_type_snapshot ?? row.doctors?.commission_type,
      specialization: row.doctors?.specialization
    }),
    commissionPercentage: Number(row.commission_percentage_snapshot ?? row.doctors?.commission_percentage ?? 0),
    commissionPerVisit: Number(row.commission_per_visit_snapshot ?? row.doctors?.commission_per_visit ?? 0),
    commissionSnapshotType: row.commission_type_snapshot || null,
    commissionSnapshotPercentage: row.commission_percentage_snapshot === null || row.commission_percentage_snapshot === undefined
      ? null
      : Number(row.commission_percentage_snapshot),
    commissionSnapshotPerVisit: row.commission_per_visit_snapshot === null || row.commission_per_visit_snapshot === undefined
      ? null
      : Number(row.commission_per_visit_snapshot),
    customCommissionPercentage: !row.commission_type_snapshot && row.doctor_id && row.treatment_type_id
      ? customRateByDoctorAndType.get(`${row.doctor_id}|${row.treatment_type_id}`)
      : undefined
  }));
  const treatmentById = new Map(treatments.map((treatment) => [treatment.id, treatment]));
  const payments = (paymentRows || []).map((row: any) => {
    const paymentDate = row.payment_date || row.created_at?.slice(0, 10) || '';
    const treatmentIds = Array.from(new Set([
      ...(Array.isArray(row.treatment_ids) ? row.treatment_ids : []),
      ...getPaymentReceiptTreatmentIds(row)
    ]));
    const specialDoctorOwner = treatmentIds
      .map((treatmentId) => treatmentById.get(treatmentId))
      .find((treatment) => treatment && treatment.date === paymentDate && Number(treatment.specialDoctorCost || 0) > 0);
    const specialDoctorVisitTotal = specialDoctorOwner
      ? treatments
          .filter((treatment) => treatment.patientId === row.patient_id && treatment.date === specialDoctorOwner.date)
          .reduce((sum, treatment) => sum + Number(treatment.cost || 0), 0)
      : 0;
    const paymentForAllocation: PaymentRecord = {
      id: String(row.id || ''),
      patientId: String(row.patient_id || ''),
      amount: Math.max(0, Number(row.amount || 0)),
      clearedAmount: Math.max(0, Number(row.cleared_amount ?? row.amount ?? 0)),
      date: paymentDate,
      type: 'PARTIAL',
      remainingBalance: 0,
      receiptSnapshot: normalizePaymentReceiptSnapshot(row.receipt_snapshot)
    };
    const standardCommissionableAmount = getPaymentCommissionableAmount(row);
    const commissionableAmount = specialDoctorVisitTotal > 0
      ? Math.max(
          standardCommissionableAmount,
          Math.min(specialDoctorVisitTotal, getPaymentAvailableTreatmentAmount(paymentForAllocation))
        )
      : standardCommissionableAmount;

    return {
      id: row.id,
      patientId: row.patient_id,
      date: paymentDate,
      createdAt: row.created_at,
      commissionableAmount,
      treatmentIds
    };
  });
  const allocations = allocateCommissionablePayments(treatments, payments);
  const existingEntries = (existingResult.data || []).map((row: any) => ({
    id: row.id,
    paymentId: row.payment_id,
    treatmentId: row.treatment_id,
    commissionRate: Number(row.commission_rate || 0),
    calculationMode: row.calculation_mode,
    visitKey: row.visit_key
  }));
  const calculatedEntries = calculateCommissionLedgerEntries(treatments, allocations, existingEntries);

  if (ledgerInstalled) {
    const treatmentById = new Map(treatmentRows.map((row: any) => [row.id, row]));
    const desiredKeys = new Set(calculatedEntries.map((entry) => `${entry.paymentId}|${entry.treatmentId}`));
    const storedRowsByKey = new Map((existingResult.data || []).map((row: any) => [`${row.payment_id}|${row.treatment_id}`, row]));
    const entryIsUnchanged = (entry: (typeof calculatedEntries)[number]): boolean => {
      const stored = storedRowsByKey.get(`${entry.paymentId}|${entry.treatmentId}`);
      if (!stored) return false;
      return sameLedgerText(stored.doctor_id, entry.doctorId)
        && sameLedgerText(stored.patient_id, entry.patientId)
        && sameLedgerText(stored.location_id, treatmentById.get(entry.treatmentId)?.location_id)
        && sameLedgerText(stored.payment_date, entry.paymentDate)
        && sameLedgerText(stored.treatment_date, entry.treatmentDate)
        && sameLedgerText(stored.visit_key, entry.visitKey)
        && sameLedgerText(stored.calculation_mode, entry.calculationMode)
        && sameLedgerMoney(stored.allocated_payment, entry.amount)
        && sameLedgerMoney(stored.material_deduction, entry.materialDeduction)
        && sameLedgerMoney(stored.commission_base, entry.commissionBase)
        && sameLedgerMoney(stored.commission_rate, entry.commissionRate)
        && sameLedgerMoney(stored.earnings, entry.earnings);
    };
    const changedEntries = calculatedEntries.filter((entry) => !entryIsUnchanged(entry));
    if (changedEntries.length > 0) {
      const { error } = await supabase
        .from('doctor_commission_entries')
        .upsert(changedEntries.map((entry) => ({
          payment_id: entry.paymentId,
          treatment_id: entry.treatmentId,
          doctor_id: entry.doctorId,
          patient_id: entry.patientId,
          location_id: treatmentById.get(entry.treatmentId)?.location_id,
          payment_date: entry.paymentDate,
          treatment_date: entry.treatmentDate,
          visit_key: entry.visitKey,
          calculation_mode: entry.calculationMode,
          allocated_payment: entry.amount,
          material_deduction: entry.materialDeduction,
          commission_base: entry.commissionBase,
          commission_rate: entry.commissionRate,
          earnings: entry.earnings
        })), { onConflict: 'payment_id,treatment_id' });
      if (error) throw new Error(error.message);
    }

    const obsoleteIds = existingEntries
      .filter((entry) => entry.id && !desiredKeys.has(`${entry.paymentId}|${entry.treatmentId}`))
      .map((entry) => entry.id as string);
    if (obsoleteIds.length > 0) {
      const { error } = await supabase.from('doctor_commission_entries').delete().in('id', obsoleteIds);
      if (error) throw new Error(error.message);
    }
  }

  const earningsByTreatment = calculatedEntries.reduce((summary, entry) => {
    summary[entry.treatmentId] = roundMoney((summary[entry.treatmentId] || 0) + entry.earnings);
    return summary;
  }, {} as Record<string, number>);
  // Only write back treatments whose stored earnings actually differ from the
  // recalculated total; a cost edit usually shifts one visit group, not history.
  const earningsChangedTreatments = treatmentRows.filter((treatment: any) => {
    const targetEarnings = earningsByTreatment[treatment.id] || 0;
    const storedEarnings = Number(treatment.doctor_earnings);
    return !Number.isFinite(storedEarnings) || Math.abs(storedEarnings - targetEarnings) >= 0.005;
  });
  await Promise.all(earningsChangedTreatments.map(async (treatment: any) => {
    const { error } = await supabase
      .from('treatments')
      .update({ doctor_earnings: earningsByTreatment[treatment.id] || 0 })
      .eq('id', treatment.id);
    if (error) throw new Error(error.message);
  }));

};

const processPendingCommissionRecalculation = async (
  patientId: string,
  requestToken: string,
  admin: { userId: string; authToken: string }
): Promise<void> => {
  await recalculatePatientDoctorCommissions(patientId);
  const { error } = await supabase.rpc('acknowledge_commission_recalculation', {
    p_patient_id: patientId,
    p_request_token: requestToken,
    p_admin_user_id: admin.userId,
    // The legacy parameter name is retained for rolling-deployment compatibility.
    p_admin_password: admin.authToken
  });
  if (error) throw new Error(error.message);
};

const recalculateDoctorEarningsForTreatments = async (treatmentIds: string[]): Promise<void> => {
  const uniqueIds = Array.from(new Set(treatmentIds.filter(Boolean)));
  if (uniqueIds.length === 0 || typeof (supabase as any).from !== 'function') return;
  const { data, error } = await supabase
    .from('treatments')
    .select('patient_id')
    .in('id', uniqueIds);
  if (error) throw new Error(error.message);
  const patientIds = Array.from(new Set((data || []).map((row: any) => row.patient_id).filter(Boolean)));
  await Promise.all(patientIds.map((patientId) => recalculatePatientDoctorCommissions(String(patientId))));
};

const refreshDoctorDefaultPercentageSnapshots = async (
  doctorId: string,
  commissionPercentage: number
): Promise<void> => {
  const { data: affectedTreatments, error: affectedTreatmentsError } = await supabase
    .from('treatments')
    .select('id, patient_id')
    .eq('doctor_id', doctorId)
    .eq('commission_type_snapshot', 'percentage')
    .eq('commission_source_snapshot', 'doctor_default');
  if (affectedTreatmentsError) {
    if (isMissingColumnError(affectedTreatmentsError, 'commission_type_snapshot')) return;
    throw new Error(affectedTreatmentsError.message);
  }

  const treatmentIds = (affectedTreatments || []).map((treatment: any) => String(treatment.id)).filter(Boolean);
  if (treatmentIds.length === 0) return;

  const { error: snapshotUpdateError } = await supabase
    .from('treatments')
    .update({
      commission_percentage_snapshot: commissionPercentage,
      commission_snapshot_at: new Date().toISOString()
    })
    .in('id', treatmentIds);
  if (snapshotUpdateError) throw new Error(snapshotUpdateError.message);

  // Existing percentage ledger rows are historical input for ordinary payment
  // corrections. This explicit doctor-rate edit is different: discard only
  // the affected rows so the recalculation takes its rate from the refreshed
  // doctor-default treatment snapshots.
  const { error: ledgerDeleteError } = await supabase
    .from('doctor_commission_entries')
    .delete()
    .in('treatment_id', treatmentIds);
  if (ledgerDeleteError && !isMissingRelationError(ledgerDeleteError, 'doctor_commission_entries')) {
    throw new Error(ledgerDeleteError.message);
  }

  const patientIds = Array.from(new Set((affectedTreatments || [])
    .map((treatment: any) => String(treatment.patient_id || ''))
    .filter(Boolean)));
  await Promise.all(patientIds.map((patientId) => recalculatePatientDoctorCommissions(patientId)));
};

const resolvePaymentCommissionTreatmentIds = async (payment: PaymentRecord): Promise<string[]> => {
  const linkedTreatmentIds = Array.from(new Set((payment.treatmentIds || []).filter(Boolean)));
  if (linkedTreatmentIds.length > 0) return linkedTreatmentIds;

  if (!payment.patientId) return [];

  const { data, error } = await supabase
    .from('treatments')
    .select('id')
    .eq('patient_id', payment.patientId);

  if (error) throw new Error(error.message);
  return (data || []).map((treatment: any) => treatment.id).filter(Boolean);
};

const buildMedicinePayload = (data: Partial<Medicine>, existing?: Partial<Medicine>): Partial<Medicine> => {
  const payload: Partial<Medicine> = {};

  if (data.location_id !== undefined) {
    payload.location_id = trimRequired(data.location_id, 'Location');
  } else if (!existing) {
    payload.location_id = trimRequired(data.location_id, 'Location');
  }

  if (data.name !== undefined) {
    payload.name = trimRequired(data.name, 'Medicine name', { maxLength: 200 });
  } else if (!existing) {
    payload.name = trimRequired(data.name, 'Medicine name', { maxLength: 200 });
  }

  if (data.description !== undefined) payload.description = trimOptional(data.description, 'Medicine description', { maxLength: 1000 }) || undefined;
  if (data.unit !== undefined) payload.unit = trimRequired(data.unit, 'Medicine unit', { maxLength: 50 });
  else if (!existing) payload.unit = 'pack';
  if (data.item_type !== undefined) {
    payload.item_type = enumValue(trimRequired(data.item_type, 'Item type', { maxLength: 100 }), MEDICINE_ITEM_TYPES, 'Item type');
  }
  else if (!existing) payload.item_type = 'Medicine';
  if (data.price !== undefined) payload.price = finiteNumber(data.price, 'Medicine price', { min: 0 });
  else if (!existing) payload.price = 0;
  if (data.stock !== undefined) payload.stock = finiteNumber(data.stock, 'Medicine stock', { min: 0 });
  else if (!existing) payload.stock = 0;
  if (data.min_stock !== undefined) payload.min_stock = finiteNumber(data.min_stock, 'Minimum stock', { min: 0 });
  else if (!existing) payload.min_stock = 0;
  if (data.quantity_step !== undefined) payload.quantity_step = finiteNumber(data.quantity_step, 'Quantity step', { min: 0.000001 });
  else if (!existing) payload.quantity_step = 1;
  if (data.category !== undefined) payload.category = trimOptional(data.category, 'Medicine category', { maxLength: 100 }) || undefined;

  return payload;
};

const isMissingRelationError = (error: any, relationName: string): boolean => {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const normalizedRelation = relationName.toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    (message.includes(normalizedRelation) && (
      message.includes('does not exist') ||
      message.includes('schema cache') ||
      message.includes('could not find the table')
    ))
  );
};

const isMissingRpcError = (error: any, functionName: string): boolean => {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const normalizedFunction = functionName.toLowerCase();
  return (
    code === '42883' ||
    code === 'PGRST202' ||
    (message.includes(normalizedFunction) && (
      message.includes('does not exist') ||
      message.includes('schema cache') ||
      message.includes('could not find the function')
    ))
  );
};

const isOptionalRelationAccessError = (error: any, relationNames: string[]): boolean => {
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  const hint = String(error?.hint || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const combined = `${message} ${details} ${hint}`;
  const normalizedRelationNames = relationNames.map((name) => name.toLowerCase());

  return normalizedRelationNames.some((relationName) => (
    isMissingRelationError(error, relationName) ||
    (
      combined.includes(relationName) &&
      (
        combined.includes('permission denied') ||
        combined.includes('not authorized') ||
        combined.includes('not authorised') ||
        combined.includes('permission') ||
        combined.includes('privilege') ||
        combined.includes('does not exist') ||
        combined.includes('schema cache') ||
        combined.includes('relationship')
      )
    ) ||
    (
      (code === '42501' || code === 'PGRST200' || code === 'PGRST201' || code === 'PGRST205') &&
      combined.includes(relationName)
    )
  ));
};

const getDoctorEarningEntriesByTreatmentIds = async (treatmentIds: string[]) => {
  const uniqueIds = Array.from(new Set(treatmentIds.filter(Boolean)));
  const entriesByTreatment = new Map<string, any[]>();
  if (uniqueIds.length === 0) return entriesByTreatment;
  const rows: any[] = [];
  // PostgREST encodes `.in()` filters in the GET request URL. Keep UUID batches
  // below common Cloudflare/Kong request-line limits used by our custom domains.
  // A 200-UUID batch is roughly 8 KB before the select list and URL escaping and
  // has produced gateway 502 responses (surfaced by browsers as a CORS failure).
  const requestBatchSize = 50;
  // This lookup only enriches treatment rows with commission-ledger breakdown details.
  // It must never block or blank out the primary treatments list (e.g. the Audit Log's
  // Treatments filter), so any failure here is logged and treated as "no entries" rather
  // than propagated to the caller's outer try/catch.
  for (let index = 0; index < uniqueIds.length; index += requestBatchSize) {
    try {
      const { data, error } = await supabase
        .from('doctor_commission_entries')
        .select('id, payment_id, treatment_id, doctor_id, payment_date, treatment_date, calculation_mode, allocated_payment, commission_rate, earnings')
        .in('treatment_id', uniqueIds.slice(index, index + requestBatchSize));

      if (error) {
        // Commission entries enrich dashboard period totals, but they must never
        // make core treatment/audit records disappear. Network/proxy failures and
        // partially deployed schemas fall back to persisted treatments.doctor_earnings.
        const errorSummary = String(error.message || error)
          .replace(/\s+/g, ' ')
          .slice(0, 240);
        console.warn('Unable to load doctor commission ledger entries; using stored treatment earnings.', errorSummary);
        return entriesByTreatment;
      }
      rows.push(...(data || []));
    } catch (err) {
      const errorSummary = String((err as any)?.message || err)
        .replace(/\s+/g, ' ')
        .slice(0, 240);
      console.warn('Unable to load doctor commission ledger entries; using stored treatment earnings.', errorSummary);
      return entriesByTreatment;
    }
  }

  rows.forEach((row: any) => {
    const entries = entriesByTreatment.get(row.treatment_id) || [];
    entries.push({
      id: row.id,
      paymentId: row.payment_id,
      treatmentId: row.treatment_id,
      doctorId: row.doctor_id,
      paymentDate: row.payment_date,
      treatmentDate: row.treatment_date,
      calculationMode: row.calculation_mode,
      allocatedPayment: Number(row.allocated_payment || 0),
      commissionRate: Number(row.commission_rate || 0),
      earnings: Number(row.earnings || 0)
    });
    entriesByTreatment.set(row.treatment_id, entries);
  });
  return entriesByTreatment;
};

const isMissingFunctionError = (error: any, functionName: string): boolean => {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const normalizedFunction = functionName.toLowerCase();
  return (
    code === '42883' ||
    code === 'PGRST202' ||
    (message.includes(normalizedFunction) && (
      message.includes('does not exist') ||
      message.includes('schema cache') ||
      message.includes('could not find the function')
    ))
  );
};

const mapPaymentCorrectionRow = (row: any): PaymentCorrection => ({
  id: row.id,
  paymentId: row.payment_id,
  oldAmount: Number(row.old_amount || 0),
  newAmount: Number(row.new_amount || 0),
  oldMethod: normalizePaymentMethod(row.old_method),
  newMethod: normalizePaymentMethod(row.new_method),
  oldAllocations: normalizePaymentAllocations(row.old_allocations),
  newAllocations: normalizePaymentAllocations(row.new_allocations),
  reason: row.reason || '',
  editedBy: row.edited_by,
  editedAt: row.edited_at,
  editorName: row.editor?.username || null
});

const mapPaymentRow = (row: any): PaymentRecord => {
  const allocations = normalizePaymentAllocations(row.payment_allocations, normalizePaymentMethod(row.payment_method), Number(row.amount || 0));
  return ({
  id: row.id,
  location_id: row.location_id,
  patientId: row.patient_id,
  patient_name: row.patients?.name || row.patient_name,
  patient_type: row.patients?.patient_type || row.patient_type || null,
  amount: Number(row.amount || 0),
  originalAmount: Number(row.original_amount ?? row.amount ?? 0),
  clearedAmount: Number(row.cleared_amount ?? row.amount ?? 0),
  treatmentIds: Array.isArray(row.treatment_ids) ? row.treatment_ids : [],
  date: row.payment_date || row.created_at?.slice(0, 10) || '',
  type: row.payment_status === 'FULL' ? 'FULL' : 'PARTIAL',
  balanceBefore: Number(row.balance_before ?? (Number(row.remaining_balance || 0) + Number(row.amount || 0))),
  remainingBalance: Number(row.remaining_balance || 0),
  patientCurrentBalance: row.patients?.balance !== undefined && row.patients?.balance !== null
    ? Number(row.patients.balance || 0)
    : undefined,
  paymentMethod: allocations.length > 0
    ? getPaymentHeaderMethod(allocations)
    : normalizePaymentMethod(row.payment_method),
  allocations,
  receiptNumber: row.receipt_number,
  receiptSnapshot: normalizePaymentReceiptSnapshot(row.receipt_snapshot),
  createdAt: row.created_at,
  createdByUserId: row.created_by_user_id,
  createdByUserName: row.created_by_user_name,
  corrections: Array.isArray(row.payment_corrections)
    ? row.payment_corrections.map(mapPaymentCorrectionRow)
    : [],
  voidedAt: row.voided_at || null,
  voidReason: row.void_reason || null,
  voidedByUserId: row.voided_by || null,
  voidedByUserName: row.voided_by_user?.username || row.voided_by_user_name || null,
  voidedAmount: row.voided_amount === undefined || row.voided_amount === null
    ? null
    : Number(row.voided_amount)
  });
};

const mapPatientMaterialCostRow = (row: any): PatientMaterialCost => {
  const costAmount = Number(row.cost_amount || 0);
  const quantity = Number(row.quantity || 0);
  return {
    id: row.id,
    auditLogId: row.audit_log_id,
    materialName: row.material_name,
    costType: row.cost_type === 'lab' ? 'lab' : row.cost_type === 'special_doctor' ? 'special_doctor' : 'material',
    costAmount,
    quantity,
    totalAmount: Number(row.total_amount ?? costAmount * quantity),
    createdBy: row.created_by || null,
    createdByName: row.users?.username || row.created_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const mapMaterialLabCostPresetRow = (row: any): MaterialLabCostPreset => ({
  id: row.id,
  costType: row.cost_type === 'lab' ? 'lab' : row.cost_type === 'special_doctor' ? 'special_doctor' : 'material',
  label: String(row.label || ''),
  amount: Number(row.amount || 0),
  sortOrder: Number(row.sort_order || 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const fetchSyntheticMaterialCostExpenses = async (
  locationId: string | undefined,
  existingExpenses: Expense[]
): Promise<Expense[]> => {
  const fetchMaterialRows = (columns: string) => fetchAllRows<any>((from, to) => supabase
    .from('patient_material_costs')
    .select(columns)
    .order('id')
    .range(from, to));
  let { data: materialRows, error: materialError } = await fetchMaterialRows(
    'audit_log_id, material_name, cost_type, total_amount, created_at, updated_at'
  );

  if (materialError && isMissingColumnError(materialError, 'cost_type')) {
    const legacyResult = await fetchMaterialRows('audit_log_id, material_name, total_amount, created_at, updated_at');
    materialRows = (legacyResult.data || []).map((row: any) => ({ ...row, cost_type: 'material' }));
    materialError = legacyResult.error;
  }

  if (materialError) {
    if (isMissingRelationError(materialError, 'patient_material_costs')) return [];
    throw materialError;
  }

  if (!materialRows || materialRows.length === 0) return [];

  const chunk = <T,>(items: T[], size: number): T[][] => {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  };

  const costSummaryByAuditAndType = new Map<string, {
    costType: TreatmentCostType;
    totalAmount: number;
    itemNames: Set<string>;
    createdAt?: string | null;
    updatedAt?: string | null;
  }>();

  (materialRows || []).forEach((row: any) => {
    const auditLogId = row.audit_log_id;
    if (!auditLogId) return;

    const costType: TreatmentCostType = row.cost_type === 'lab' ? 'lab' : row.cost_type === 'special_doctor' ? 'special_doctor' : 'material';
    const summaryKey = `${auditLogId}|${costType}`;
    const current = costSummaryByAuditAndType.get(summaryKey) || {
      costType,
      totalAmount: 0,
      itemNames: new Set<string>(),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };

    current.totalAmount += Number(row.total_amount || 0);
    if (row.material_name) current.itemNames.add(row.material_name);
    current.createdAt = current.createdAt || row.created_at || null;
    current.updatedAt = row.updated_at || current.updatedAt || null;
    costSummaryByAuditAndType.set(summaryKey, current);
  });

  const auditIds = Array.from(new Set((materialRows || []).map((row: any) => row.audit_log_id).filter(Boolean)));
  if (auditIds.length === 0) return [];

  const auditBatches = await Promise.all(chunk(auditIds, 25).map(async (auditIdBatch) => {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('id, source_id, location_id')
      .eq('source_type', 'treatment')
      .in('id', auditIdBatch);

    if (error) {
      if (isMissingRelationError(error, 'audit_logs')) return [];
      throw error;
    }

    return data || [];
  }));

  const auditRows: any[] = auditBatches.flat();
  if (auditRows.length === 0) return [];

  const treatmentIds = Array.from(new Set(auditRows.map((row) => row.source_id).filter(Boolean)));
  const treatmentBatches = await Promise.all(chunk(treatmentIds, 25).map(async (treatmentIdBatch) => {
    const { data, error } = await supabase
      .from('treatments')
      .select('id, location_id, patient_id, date, description, patients(name)')
      .in('id', treatmentIdBatch);

    if (error) {
      if (isOptionalRelationAccessError(error, ['patients'])) {
        const fallback = await supabase
          .from('treatments')
          .select('id, location_id, patient_id, date, description')
          .in('id', treatmentIdBatch);
        if (fallback.error) throw fallback.error;
        return fallback.data || [];
      }
      throw error;
    }

    return data || [];
  }));

  const treatmentById = new Map(treatmentBatches.flat().map((row: any) => [row.id, row]));
  const linkedExpenseKeys = new Set(
    existingExpenses
      .filter((expense) => ['material_cost', 'lab_cost', 'special_doctor_cost'].includes(expense.source_type || '') && expense.source_id)
      .map((expense) => `${expense.source_id}|${expense.source_type}`)
  );

  return auditRows.flatMap((auditRow: any): Expense[] => {
    const treatment = treatmentById.get(auditRow.source_id);
    if (!treatment) return [];

    const resolvedLocationId = auditRow.location_id || treatment.location_id || null;
    if (locationId && resolvedLocationId !== locationId) return [];
    return (['material', 'lab'] as TreatmentCostType[]).flatMap((costType): Expense[] => {
      const summary = costSummaryByAuditAndType.get(`${auditRow.id}|${costType}`);
      if (!summary || summary.totalAmount <= 0) return [];
      const metadata = getTreatmentCostExpenseMetadata(costType);
      if (linkedExpenseKeys.has(`${auditRow.id}|${metadata.sourceType}`)) return [];
      const treatmentContext = {
        patient_name: treatment.patients?.name || 'Unknown patient',
        description: treatment.description || 'Treatment'
      };
      const description = buildTreatmentCostExpenseDescription(treatmentContext, Array.from(summary.itemNames).join(', '), costType);
      const prefix = buildTreatmentCostExpensePrefix(treatmentContext, costType);
      const hasLegacyExpense = existingExpenses.some((expense) => (
        expense.category === metadata.category &&
        expense.location_id === resolvedLocationId &&
        expense.date === treatment.date &&
        expense.description.startsWith(prefix)
      ));
      if (hasLegacyExpense) return [];

      return [{
        id: `${metadata.sourceType.replace('_', '-')}-${auditRow.id}`,
        location_id: resolvedLocationId,
        description,
        amount: summary.totalAmount,
        category: metadata.category,
        date: treatment.date || summary.createdAt?.slice(0, 10) || '',
        source_type: metadata.sourceType,
        source_id: auditRow.id,
        is_system_generated: true,
        created_at: summary.createdAt || undefined,
        updated_at: summary.updatedAt || undefined
      }];
    });
  });
};

const detectUsersAllowedTabsSupport = async (): Promise<boolean> => {
  if (usersAllowedTabsSupport !== null) {
    return usersAllowedTabsSupport;
  }

  const { error } = await supabase
    .from('users')
    .select('allowed_tabs')
    .limit(1);

  if (error) {
    if (isMissingColumnError(error, 'allowed_tabs')) {
      usersAllowedTabsSupport = false;
      return false;
    }

    throw error;
  }

  usersAllowedTabsSupport = true;
  return true;
};

const detectUsersDoctorIdSupport = async (): Promise<boolean> => {
  if (usersDoctorIdSupport !== null) {
    return usersDoctorIdSupport;
  }

  const { error } = await supabase
    .from('users')
    .select('doctor_id')
    .limit(1);

  if (error) {
    if (isMissingColumnError(error, 'doctor_id')) {
      usersDoctorIdSupport = false;
      return false;
    }

    throw error;
  }

  usersDoctorIdSupport = true;
  return true;
};

const detectDoctorLocationsSupport = async (): Promise<boolean> => {
  if (doctorLocationsSupport !== null) return doctorLocationsSupport;

  const { error } = await supabase
    .from('doctor_locations')
    .select('doctor_id')
    .limit(1);

  if (error) {
    if (isMissingRelationError(error, 'doctor_locations')) {
      doctorLocationsSupport = false;
      return false;
    }
    throw error;
  }

  doctorLocationsSupport = true;
  return true;
};

const getDoctorLocationIds = (data: Partial<Doctor> | any): string[] => {
  const ids = Array.isArray(data.location_ids) ? data.location_ids : [data.location_id];
  const normalized = ids.map((id: unknown) => String(id || '').trim()).filter(Boolean) as string[];
  return Array.from(new Set(normalized));
};

const saveDoctorLocations = async (doctorId: string, locationIds: string[]) => {
  if (!(await detectDoctorLocationsSupport())) return;

  await supabase.from('doctor_locations').delete().eq('doctor_id', doctorId);
  if (locationIds.length === 0) return;

  const { error } = await supabase
    .from('doctor_locations')
    .insert(locationIds.map((location_id) => ({ doctor_id: doctorId, location_id })));

  if (error) throw new Error(error.message);
};

const mapDoctor = (doc: any): Doctor => {
  const joinedLocationIds = Array.isArray(doc.doctor_locations)
    ? doc.doctor_locations.map((row: any) => row.location_id).filter(Boolean)
    : [];
  const location_ids = joinedLocationIds.length ? joinedLocationIds : [doc.location_id].filter(Boolean);

  return {
    id: doc.id,
    location_id: doc.location_id,
    location_ids,
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    specialization: doc.specialization,
    commission_type: resolveDoctorCommissionType({
      commissionType: doc.commission_type,
      specialization: doc.specialization
    }),
    commission_percentage: doc.commission_percentage ?? 0,
    commission_per_visit: doc.commission_per_visit ?? 0,
    schedules: (doc.doctor_schedules || []).map((sched: any) => ({
      id: sched.id,
      doctor_id: sched.doctor_id,
      day_of_week: sched.day_of_week,
      start_time: sched.start_time,
      end_time: sched.end_time
    })),
    created_at: doc.created_at
  };
};

const detectConversationsDoctorUserSupport = async (): Promise<boolean> => {
  if (conversationsDoctorUserSupport !== null) {
    return conversationsDoctorUserSupport;
  }

  const { error } = await supabase
    .from('conversations')
    .select('doctor_user_id')
    .limit(1);

  if (error) {
    if (isMissingColumnError(error, 'doctor_user_id')) {
      conversationsDoctorUserSupport = false;
      return false;
    }

    throw error;
  }

  conversationsDoctorUserSupport = true;
  return true;
};

// Utility: map DB snake_case fields to app camelCase
const mapPatient = (row: any): Patient => ({
  ...row,
  patient_unique_id: row?.patient_unique_id ?? undefined,
  township: row?.township ?? row?.state_region ?? undefined,
  loyalty_points: row?.loyalty_points ?? 0,
  medicalHistory: row?.medical_history ?? row?.medicalHistory,
  created_at: row?.created_at,
  has_account: Array.isArray(row?.patient_auth) ? row.patient_auth.length > 0 : !!row?.patient_auth,
  username: Array.isArray(row?.patient_auth) ? (row.patient_auth[0]?.username ?? null) : (row?.patient_auth?.username ?? null)
});

const getTrimmedDoctorName = (value?: string | null): string | undefined => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
};

const getJoinedOne = <T = any>(value: T | T[] | null | undefined): T | null => (
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
);

const getLocalISODate = (date = new Date()): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const getLocalDateBoundaryISO = (date: string, addDays = 0): string => {
  const [year, month, day] = date.split('-').map(Number);
  const boundary = new Date(year, (month || 1) - 1, (day || 1) + addDays);
  return boundary.toISOString();
};

const getOneMonthAgoISO = (date = new Date()): string => {
  const cutoff = new Date(date);
  cutoff.setMonth(cutoff.getMonth() - 1);
  return cutoff.toISOString();
};

const getAutoOnpPatientTypeEnabled = async (): Promise<boolean> => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('auto_onp_patient_type_enabled')
      .eq('id', APP_SETTINGS_SINGLETON_ID)
      .maybeSingle();

    if (error || !data) {
      if (error && !isMissingColumnError(error, 'auto_onp_patient_type_enabled')) {
        console.warn('Failed to load auto ONP patient type setting:', error.message);
      }
      return false;
    }

    return Boolean(data.auto_onp_patient_type_enabled);
  } catch (error: any) {
    console.warn('Failed to load auto ONP patient type setting:', error?.message || error);
    return false;
  }
};

const applyAutoOnpPatientTypeIfEnabled = async (locationId?: string): Promise<void> => {
  const enabled = await getAutoOnpPatientTypeEnabled();
  if (!enabled) return;

  const cutoffIso = getOneMonthAgoISO();

  let selectQuery = supabase
    .from('patients')
    .select('id, patient_type')
    .lte('created_at', cutoffIso)
    .or(`patient_type.is.null,patient_type.neq.${AUTO_ONP_PATIENT_TYPE_NAME}`);

  if (locationId) {
    selectQuery = selectQuery.eq('location_id', locationId);
  }

  const { data: eligiblePatients, error: selectError } = await selectQuery;
  if (selectError) {
    console.warn('Failed to find patients eligible for auto ONP conversion:', selectError.message);
    return;
  }

  const eligibleIds = (eligiblePatients || [])
    .filter((patient: any) => String(patient.patient_type || '').trim() !== AUTO_ONP_PATIENT_TYPE_NAME)
    .map((patient: any) => patient.id)
    .filter(Boolean);

  if (eligibleIds.length === 0) return;

  const { error: updateError } = await supabase
    .from('patients')
    .update({ patient_type: AUTO_ONP_PATIENT_TYPE_NAME })
    .in('id', eligibleIds);

  if (updateError) {
    console.warn('Failed to auto-convert patients to ONP:', updateError.message);
  }
};

const completeAppointmentWithClinicalFee = async (
  appointmentId: string,
  skipClinicalFee = false
): Promise<ClinicalFeeCompletionResult> => {
  const statusToPersist = skipClinicalFee ? 'SKIPPED' : 'NOT_APPLICABLE';
  const { data, error } = await supabase
    .from('appointments')
    .update({
      status: 'Completed',
      clinical_fee_status: statusToPersist,
      clinical_fee_amount: 0,
      clinical_fee_patient_category: null,
      clinical_fee_applied_at: null
    })
    .eq('id', appointmentId)
    .select('id, clinical_fee_status, clinical_fee_amount, clinical_fee_patient_category')
    .single();

  if (error) {
    if (isMissingColumnError(error, 'clinical_fee_status')) {
      const legacyResult = await supabase
        .from('appointments')
        .update({ status: 'Completed' })
        .eq('id', appointmentId)
        .select('id')
        .single();

      if (legacyResult.error) {
        throw new Error(legacyResult.error.message);
      }

      return {
        appointmentId,
        feeStatus: 'NOT_APPLICABLE',
        feeAmount: 0,
        patientCategory: null,
        newBalance: null
      };
    }

    throw new Error(error.message);
  }

  const row = getJoinedOne(data);
  return {
    appointmentId: row?.id || appointmentId,
    feeStatus: row?.clinical_fee_status || 'NOT_APPLICABLE',
    feeAmount: Number(row?.clinical_fee_amount || 0),
    patientCategory: row?.clinical_fee_patient_category || null,
    newBalance: null
  };
};

const getAppointmentDoctorDisplayName = (appointmentRow: any, clinicalDoctorName?: string): string | undefined => {
  if (appointmentRow?.status === 'Completed') {
    const completedDoctorName = getTrimmedDoctorName(clinicalDoctorName);
    if (completedDoctorName) {
      return completedDoctorName;
    }
  }

  return getTrimmedDoctorName(appointmentRow?.doctors?.name);
};

const fetchAppointmentPrimaryById = async (id: string): Promise<any> => {
  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(error.message);
  return data;
};

const fetchDoctorWithOptionalRelations = async (id: string): Promise<any> => {
  let supportsDoctorLocations = false;
  try {
    supportsDoctorLocations = await detectDoctorLocationsSupport();
  } catch (supportError) {
    console.warn('Could not check doctor branch assignments. Fetching doctor without optional branch assignments.', supportError);
  }

  let { data, error } = await supabase
    .from('doctors')
    .select(`*, doctor_schedules(*)${supportsDoctorLocations ? ', doctor_locations(location_id)' : ''}`)
    .eq('id', id)
    .single();

  if (error && isOptionalRelationAccessError(error, ['doctor_schedules', 'doctor_locations'])) {
    const fallback = await supabase
      .from('doctors')
      .select('*')
      .eq('id', id)
      .single();
    data = fallback.data;
    error = fallback.error;
  }

  if (error) throw new Error(error.message);
  return data;
};

const mapAppointmentRescheduleLog = (row: any): AppointmentRescheduleLog => ({
  id: row.id,
  appointment_id: row.appointment_id,
  location_id: row.location_id,
  patient_id: row.patient_id ?? null,
  patient_name: row.patient_name || 'Unknown',
  doctor_name: row.doctor_name ?? null,
  original_date: row.original_date,
  new_date: row.new_date,
  reason: row.reason || '',
  admin_user_id: row.admin_user_id ?? null,
  admin_name: row.admin_name ?? null,
  created_at: row.created_at
});

export const normalizeMyanmarPhoneForLookup = (value?: string | null): string | null => {
  const digits = (value || '').replace(/\D/g, '');
  let localDigits = digits;

  if (digits.startsWith('95')) {
    const withoutCountryCode = digits.slice(2);
    if (withoutCountryCode.length >= 8 && withoutCountryCode.length <= 10 && withoutCountryCode.startsWith('9')) {
      localDigits = `0${withoutCountryCode}`;
    }
  } else if (digits.length >= 8 && digits.length <= 10 && digits.startsWith('9')) {
    localDigits = `0${digits}`;
  }

  return /^09\d{7,9}$/.test(localDigits) ? localDigits : null;
};

const normalizePhoneDigitsForLookup = (value?: string | null): string | null => {
  const normalizedMyanmarPhone = normalizeMyanmarPhoneForLookup(value);
  if (normalizedMyanmarPhone) return normalizedMyanmarPhone;

  const digits = (value || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
};

const normalizePhoneForStorage = (value?: string | null): string | null => {
  const normalizedMyanmarPhone = normalizeMyanmarPhoneForLookup(value);
  if (normalizedMyanmarPhone) return normalizedMyanmarPhone;
  const trimmed = value?.trim();
  return trimmed || null;
};

const normalizePatientUsernameForAuth = (value?: string | null): string | null => {
  const normalized = value?.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
};

class ApiValidationError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>, status = 422) {
    super(message);
    this.name = 'ApiValidationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details || null
      }
    };
  }
}

const isValidEmailAddress = (email?: string | null) => {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const truncateMessagePreview = (value: string, limit = 220) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
};

// Storage bucket for patient uploads
const PATIENT_FILES_BUCKET = 'patient_files';
const APP_LOGOS_BUCKET = 'app_logos';
const APP_SETTINGS_SINGLETON_ID = 1;
let cachedS3Settings: S3Settings | null = null;

const isMissingTableError = (error: any, tableName: string): boolean => {
  return typeof error?.message === 'string' && error.message.toLowerCase().includes(tableName.toLowerCase());
};

const normalizeS3SettingsRow = (row: any): S3Settings => ({
  url: row?.s3_url || '',
  accessKey: row?.s3_access_key || '',
  secretKey: row?.s3_secret_key || '',
  region: row?.s3_region || '',
  updated_at: row?.updated_at
});

const DEFAULT_PATIENT_TYPES: PatientType[] = DEFAULT_PATIENT_TYPE_OPTIONS.map((name, index) => ({
  id: `default-${index + 1}`,
  name,
  sort_order: index,
  is_active: true
}));

const fetchS3Settings = async (): Promise<S3Settings | null> => {
  const { data, error } = await supabase
    .from('app_settings')
    .select('s3_url, s3_access_key, s3_secret_key, s3_region, updated_at')
    .eq('id', APP_SETTINGS_SINGLETON_ID)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error, 'app_settings')) {
      return null;
    }
    throw new Error(error.message);
  }

  if (!data) return null;
  return normalizeS3SettingsRow(data);
};

const resolveActiveS3Settings = async (): Promise<S3Settings | null> => {
  if (cachedS3Settings && isS3SettingsReady(cachedS3Settings)) {
    return cachedS3Settings;
  }

  const settings = await fetchS3Settings();
  if (!settings || !isS3SettingsReady(settings)) {
    return null;
  }

  cachedS3Settings = settings;
  return settings;
};

const resolveActiveSupabaseStorage = async (): Promise<import('../types').SupabaseStorageSettings | null> => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('storage_url, storage_anon_key, storage_service_key, storage_bucket')
      .eq('id', APP_SETTINGS_SINGLETON_ID)
      .maybeSingle();

    console.log('[resolveActiveSupabaseStorage] DB response:', {
      hasData: !!data,
      error: error?.message,
      storage_url: data?.storage_url?.substring(0, 30) + '...',
      storage_anon_key: data?.storage_anon_key ? 'SET' : 'NULL',
      storage_bucket: data?.storage_bucket
    });

    if (error || !data) return null;

    const settings: import('../types').SupabaseStorageSettings = {
      storageUrl: data.storage_url || '',
      anonKey: data.storage_anon_key || '',
      serviceKey: data.storage_service_key || '',
      bucket: data.storage_bucket || ''
    };

    const isReady = isSupabaseStorageReady(settings);
    console.log('[resolveActiveSupabaseStorage] Settings ready?', isReady, settings);
    
    return isReady ? settings : null;
  } catch (err: any) {
    console.error('[resolveActiveSupabaseStorage] Error:', err?.message);
    return null;
  }
};

export const api = {
  locations: {
    getAll: async (): Promise<Location[]> => {
      try {
        const { data, error } = await supabase
          .from('locations')
          .select('*')
          .order('name');
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn("Error fetching locations:", err);
        return [];
      }
    },
    create: async (data: Partial<Location>): Promise<Location> => {
      const { data: result, error } = await supabase
        .from('locations')
        .insert(data)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    update: async (id: string, data: Partial<Location>): Promise<Location> => {
      const { data: result, error } = await supabase
        .from('locations')
        .update(data)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('locations')
        .delete()
        .eq('id', id);
      if (error) throw new Error(error.message);
    }
  },

  patientTypes: {
    getAll: async (): Promise<PatientType[]> => {
      try {
        const { data, error } = await supabase
          .from('patient_types')
          .select('*')
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true });

        if (error) {
          if (isMissingTableError(error, 'patient_types')) {
            return DEFAULT_PATIENT_TYPES;
          }
          throw error;
        }

        if (!data || data.length === 0) {
          return DEFAULT_PATIENT_TYPES;
        }

        return data;
      } catch (err) {
        console.warn('Error fetching patient types:', err);
        return DEFAULT_PATIENT_TYPES;
      }
    },
    create: async (data: Partial<PatientType>): Promise<PatientType> => {
      const payload = {
        name: (data.name || '').trim(),
        sort_order: Number.isFinite(Number(data.sort_order)) ? Number(data.sort_order) : 0,
        is_active: data.is_active ?? true
      };

      const { data: result, error } = await supabase
        .from('patient_types')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return result;
    },
    update: async (id: string, data: Partial<PatientType>): Promise<PatientType> => {
      const { data: existing, error: existingError } = await supabase
        .from('patient_types')
        .select('*')
        .eq('id', id)
        .single();

      if (existingError) throw new Error(existingError.message);

      const payload = {
        name: data.name !== undefined ? data.name.trim() : existing.name,
        sort_order: data.sort_order !== undefined ? Number(data.sort_order) : existing.sort_order,
        is_active: data.is_active ?? existing.is_active,
        updated_at: new Date().toISOString()
      };

      const { data: result, error } = await supabase
        .from('patient_types')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);

      if (existing.name !== payload.name) {
        const { error: patientUpdateError } = await supabase
          .from('patients')
          .update({ patient_type: payload.name })
          .eq('patient_type', existing.name);

        if (patientUpdateError) {
          throw new Error(patientUpdateError.message);
        }
      }

      return result;
    },
    delete: async (id: string): Promise<void> => {
      const { data: existing, error: existingError } = await supabase
        .from('patient_types')
        .select('name')
        .eq('id', id)
        .single();

      if (existingError) throw new Error(existingError.message);

      const { count, error: usageError } = await supabase
        .from('patients')
        .select('id', { count: 'exact', head: true })
        .eq('patient_type', existing.name);

      if (usageError) throw new Error(usageError.message);
      if ((count || 0) > 0) {
        throw new Error(`Cannot delete "${existing.name}" because it is already used by patient records.`);
      }

      const { error } = await supabase
        .from('patient_types')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
    }
  },

  appointmentTypes: {
    getAll: async (): Promise<AppointmentType[]> => {
      try {
        const { data, error } = await supabase
          .from('appointment_types')
          .select('*')
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true });

        if (error) {
          if (isMissingTableError(error, 'appointment_types')) {
            return [];
          }
          throw error;
        }

        if (!data || data.length === 0) {
          return [];
        }

        return data;
      } catch (err) {
        console.warn('Error fetching appointment types:', err);
        return [];
      }
    },
    create: async (data: Partial<AppointmentType>): Promise<AppointmentType> => {
      const payload = {
        name: (data.name || '').trim(),
        sort_order: Number.isFinite(Number(data.sort_order)) ? Number(data.sort_order) : 0,
        is_active: data.is_active ?? true
      };

      const { data: result, error } = await supabase
        .from('appointment_types')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return result;
    },
    update: async (id: string, data: Partial<AppointmentType>): Promise<AppointmentType> => {
      const { data: result, error } = await supabase
        .from('appointment_types')
        .update({
          ...(data.name !== undefined ? { name: data.name.trim() } : {}),
          ...(data.sort_order !== undefined ? { sort_order: Number(data.sort_order) } : {}),
          ...(data.is_active !== undefined ? { is_active: data.is_active } : {}),
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return result;
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('appointment_types')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
    }
  },

  patients: {
    checkDuplicate: async (
      data: Pick<Partial<Patient>, 'name' | 'phone' | 'age'> & { excludePatientId?: string }
    ): Promise<{
      isDuplicate: boolean;
      match: Pick<Patient, 'id' | 'name' | 'phone' | 'age' | 'location_id' | 'created_at'> | null;
    }> => {
      const normalizedPhoneDigits = normalizePhoneDigitsForLookup(data.phone);
      const normalizedAge = typeof data.age === 'number' && Number.isFinite(data.age)
        ? data.age
        : Number.parseInt(String(data.age || ''), 10);

      if (!normalizedPhoneDigits || !Number.isFinite(normalizedAge)) {
        return { isDuplicate: false, match: null };
      }

      let query = supabase
        .from('patients')
        .select('id, name, phone, age, location_id, created_at')
        .eq('age', normalizedAge)
        .limit(50);

      if (data.excludePatientId) {
        query = query.neq('id', data.excludePatientId);
      }

      const { data: rows, error } = await query;
      if (error) throw new Error(error.message);

      const match = (rows || []).find((row: any) => {
        return normalizePhoneDigitsForLookup(row.phone) === normalizedPhoneDigits;
      });

      return {
        isDuplicate: !!match,
        match: match
          ? {
              id: match.id,
              name: match.name,
              phone: match.phone,
              age: match.age,
              location_id: match.location_id,
              created_at: match.created_at
            }
          : null
      };
    },
    getAll: async (locationId?: string): Promise<Patient[]> => {
      try {
        await applyAutoOnpPatientTypeIfEnabled(locationId);

        const basePatientColumns = 'id, patient_unique_id, location_id, name, email, phone, age, address, city, patient_type, balance, loyalty_points, medical_history, created_at';
        const baseColumns = `${basePatientColumns}, patient_auth(id, username)`;
        const buildQuery = (regionColumn: 'township' | 'state_region', offset: number) => {
          let query = supabase
            .from('patients')
            .select(`${baseColumns}, ${regionColumn}`)
            .order('created_at', { ascending: false })
            .order('id')
            .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

          if (locationId) {
            query = query.eq('location_id', locationId);
          }

          return query;
        };

        const patients: any[] = [];
        for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
          const initialResult = await buildQuery('township', offset);
          let data: any[] | null = initialResult.data;
          let error: any = initialResult.error;

          if (error && isMissingColumnError(error, 'township')) {
            const fallbackResult = await buildQuery('state_region', offset);
            data = fallbackResult.data;
            error = fallbackResult.error;
          }

          if (error && isOptionalRelationAccessError(error, ['patient_auth'])) {
            const buildPatientOnlyQuery = (regionColumn: 'township' | 'state_region', pageOffset: number) => {
              let query = supabase
                .from('patients')
                .select(`${basePatientColumns}, ${regionColumn}`)
                .order('created_at', { ascending: false })
                .order('id')
                .range(pageOffset, pageOffset + SUPABASE_PAGE_SIZE - 1);

              if (locationId) {
                query = query.eq('location_id', locationId);
              }

              return query;
            };

            const fallbackResult = await buildPatientOnlyQuery('township', offset);
            data = fallbackResult.data;
            error = fallbackResult.error;

            if (error && isMissingColumnError(error, 'township')) {
              const legacyFallbackResult = await buildPatientOnlyQuery('state_region', offset);
              data = legacyFallbackResult.data;
              error = legacyFallbackResult.error;
            }
          }

          if (error) throw error;
          const page = data || [];
          patients.push(...page);
          if (page.length < SUPABASE_PAGE_SIZE) break;
        }
        return patients.map(mapPatient);
      } catch (err) {
        console.warn("Error fetching patients:", err);
        return []; // Return empty array instead of crashing
      }
    },
    create: async (data: Partial<Patient> & { password?: string; username?: string }): Promise<Patient> => {
      // First, check if the patients table exists
      try {
        const { error: tableError } = await supabase
          .from('patients')
          .select('id')
          .limit(1);
        
        if (tableError) throw new Error(`Patients table access failed: ${tableError.message}`);
      } catch (tableCheckError: any) {
        console.error('Table check error:', tableCheckError);
        throw new Error(`Database table error: ${tableCheckError.message || 'Failed to connect to database'}`);
      }
      
      // Handle location assignment
      let finalLocationId = data.location_id;
      
      // If no location_id provided or it's 'main', get or create default location
      if (!finalLocationId || finalLocationId === 'main') {
        try {
          // Try to get existing locations
          const { data: locations, error: locationsError } = await supabase
            .from('locations')
            .select('id')
            .limit(1);
          
          if (locationsError) {
            console.warn('Failed to fetch locations:', locationsError.message);
            // Create default location if none exist
            const { data: newLocation, error: createError } = await supabase
              .from('locations')
              .insert({
                name: 'Main Clinic',
                address: 'Default Address',
                phone: '000-000-0000'
              })
              .select()
              .single();
            
            if (createError) throw new Error(`Failed to create default location: ${createError.message}`);
            finalLocationId = newLocation.id;
          } else if (locations && locations.length > 0) {
            finalLocationId = locations[0].id;
          } else {
            // No locations exist, create one
            const { data: newLocation, error: createError } = await supabase
              .from('locations')
              .insert({
                name: 'Main Clinic',
                address: 'Default Address',
                phone: '000-000-0000'
              })
              .select()
              .single();
            
            if (createError) throw new Error(`Failed to create default location: ${createError.message}`);
            finalLocationId = newLocation.id;
          }
        } catch (locationHandlingError: any) {
          console.error('Location handling error:', locationHandlingError);
          throw new Error(`Location handling error: ${locationHandlingError.message}`);
        }
      } else {
        // Check if the provided location exists
        try {
          const { error: locationError } = await supabase
            .from('locations')
            .select('id')
            .eq('id', finalLocationId)
            .single();
          
          if (locationError) throw new Error(`Location not found: ${finalLocationId}`);
        } catch (locationCheckError: any) {
          console.error('Location check error:', locationCheckError);
          throw new Error(`Location validation error: ${locationCheckError.message}`);
        }
      }
      
      const normalizedEmail = data.email ? data.email.toLowerCase().trim() : data.email;
      const normalizedPhone = normalizePhoneForStorage(data.phone);
      const duplicateCheck = await api.patients.checkDuplicate({
        name: data.name,
        phone: normalizedPhone || data.phone,
        age: data.age
      });
      if (duplicateCheck.isDuplicate && duplicateCheck.match) {
        throw new ApiValidationError(
          'A patient with the same phone number and age already exists.',
          'DUPLICATE_PATIENT',
          {
            duplicate_patient_id: duplicateCheck.match.id,
            duplicate_name: duplicateCheck.match.name,
            duplicate_phone: duplicateCheck.match.phone,
            duplicate_age: duplicateCheck.match.age,
            duplicate_location_id: duplicateCheck.match.location_id,
            duplicate_created_at: duplicateCheck.match.created_at
          }
        );
      }
      const payload = {
        location_id: finalLocationId,
        name: data.name,
        email: normalizedEmail,
        phone: normalizedPhone,
        age: data.age || null,
        address: data.address || null,
        city: data.city || null,
        township: data.township || null,
        patient_type: data.patient_type || DEFAULT_PATIENT_TYPE_NAME,
        balance: data.balance ?? 0,
        loyalty_points: 0,
        medical_history: data.medicalHistory || null,
        ...(data.created_at ? { created_at: buildPatientCreatedAt(data.created_at) } : {})
      };

      const { data: result, error } = await supabase
        .from('patients')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);

      // If password is provided, create auth record
      if (data.password) {
        const { error: authError } = await supabase
          .from('patient_auth')
          .insert({
            patient_id: result.id,
            location_id: finalLocationId,
            username: normalizePatientUsernameForAuth(data.username),
            email: normalizedEmail || null,
            phone: normalizedPhone || null,
            password: data.password,
            is_verified: true
          });
        
        if (authError) {
          console.warn('Patient created but auth record failed:', authError.message);
        }
      }

      return mapPatient(result);
    },
    checkPatientRecords: async (patientId: string): Promise<{
      hasAppointments: boolean;
      hasTreatments: boolean;
      hasLoyalty: boolean;
      hasAny: boolean;
    }> => {
      const [
        { count: appointmentCount, error: appointmentError },
        { count: treatmentCount, error: treatmentError },
        { count: loyaltyCount, error: loyaltyError }
      ] = await Promise.all([
        supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('patient_id', patientId),
        supabase
          .from('treatments')
          .select('id', { count: 'exact', head: true })
          .eq('patient_id', patientId),
        supabase
          .from('loyalty_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('patient_id', patientId)
      ]);

      if (appointmentError) throw new Error(appointmentError.message);
      if (treatmentError) throw new Error(treatmentError.message);
      if (loyaltyError) throw new Error(loyaltyError.message);

      const hasAppointments = (appointmentCount || 0) > 0;
      const hasTreatments = (treatmentCount || 0) > 0;
      const hasLoyalty = (loyaltyCount || 0) > 0;

      return {
        hasAppointments,
        hasTreatments,
        hasLoyalty,
        hasAny: hasAppointments || hasTreatments || hasLoyalty
      };
    },
    update: async (id: string, data: Partial<Patient>): Promise<Patient> => {
      if (data.location_id !== undefined) {
        const { data: existingPatient, error: existingPatientError } = await supabase
          .from('patients')
          .select('location_id')
          .eq('id', id)
          .single();

        if (existingPatientError) throw new Error(existingPatientError.message);

        const isBranchTransfer =
          !!data.location_id &&
          !!existingPatient?.location_id &&
          data.location_id !== existingPatient.location_id;

        if (isBranchTransfer) {
          const patientRecordState = await api.patients.checkPatientRecords(id);
          if (patientRecordState.hasAny) {
            throw new Error('Cannot transfer branch: Patient has existing records');
          }
        }
      }

      const normalizedEmail = data.email ? data.email.toLowerCase().trim() : data.email;
      const normalizedPhone = normalizePhoneForStorage(data.phone);
      const payload = buildPatientProfileUpdatePayload(data, normalizedEmail, normalizedPhone);

      const { data: result, error } = await supabase
        .from('patients')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      
      // Keep patient_auth in sync for account lookups and branch-scoped access.
      if (data.phone !== undefined || data.email !== undefined || data.location_id !== undefined) {
        const authUpdateData: any = {};
        if (data.phone !== undefined) authUpdateData.phone = normalizedPhone;
        if (data.email !== undefined) authUpdateData.email = normalizedEmail;
        if (data.location_id !== undefined) authUpdateData.location_id = data.location_id || null;
        
        const { error: authError } = await supabase
          .from('patient_auth')
          .update(authUpdateData)
          .eq('patient_id', id);
          
        if (authError) {
          console.warn('Email/phone updated in patients table but failed to update in patient_auth table:', authError.message);
        }
      }
      
      return mapPatient(result);
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase.rpc('delete_patient_atomic', { p_patient_id: id });
      if (error) {
        if (isMissingFunctionError(error, 'delete_patient_atomic')) {
          throw new Error('Atomic patient deletion is not installed. Apply the atomic clinical workflows migration before deleting patients.');
        }
        throw new Error(error.message);
      }

    },


    // Update or create patient auth record
    updateAccount: async (
      patientId: string, 
      email: string | null, 
      password: string, 
      phone?: string | null,
      username?: string | null
    ): Promise<void> => {
      const normalizedEmail = email ? email.toLowerCase().trim() : email;
      const normalizedPhone = normalizePhoneForStorage(phone);
      const normalizedUsername = normalizePatientUsernameForAuth(username);
      const { data: patientRecord, error: patientError } = await supabase
        .from('patients')
        .select('location_id')
        .eq('id', patientId)
        .maybeSingle();

      if (patientError) {
        throw new Error(patientError.message);
      }

      const patientLocationId = patientRecord?.location_id || null;

      if (normalizedEmail) {
        const { data: emailOwner, error: emailOwnerError } = await supabase
          .from('patient_auth')
          .select('patient_id')
          .eq('email', normalizedEmail)
          .maybeSingle();
        if (emailOwnerError) throw new Error(emailOwnerError.message);
        if (emailOwner?.patient_id && emailOwner.patient_id !== patientId) {
          throw new Error('This email is already used by another patient portal account. Update the patient email or use the existing portal account.');
        }
      }

      // Check if auth record exists
      const { data: existing } = await supabase
        .from('patient_auth')
        .select('id')
        .eq('patient_id', patientId)
        .maybeSingle();

      if (existing) {
        // Update
        const updateData: any = { password, email: normalizedEmail, location_id: patientLocationId };
        if (phone !== undefined) updateData.phone = normalizedPhone;
        if (username !== undefined) updateData.username = normalizedUsername ?? null;
        
        const { error } = await supabase
          .from('patient_auth')
          .update(updateData)
          .eq('patient_id', patientId);
        if (error) throw new Error(getPatientAuthConflictMessage(error) || error.message);
      } else {
        // Create
        const { error } = await supabase
          .from('patient_auth')
          .insert({
            patient_id: patientId,
            location_id: patientLocationId,
            username: normalizedUsername ?? null,
            email: normalizedEmail,
            phone: normalizedPhone || null,
            password: password,
            is_verified: true
          });
        if (error) throw new Error(getPatientAuthConflictMessage(error) || error.message);
      }
    },

    updatePasswordByEmail: async (
      email: string,
      password: string,
      supabaseUserId?: string
    ): Promise<void> => {
      const normalizedEmail = email.toLowerCase().trim();
      if (!normalizedEmail) {
        throw new Error('Email is required to update the patient password.');
      }

      const updateData: Record<string, any> = {
        password,
        is_verified: true
      };

      if (supabaseUserId) {
        updateData.supabase_user_id = supabaseUserId;
      }

      const { data: existingAuth, error: fetchError } = await supabase
        .from('patient_auth')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (fetchError) {
        throw new Error(fetchError.message);
      }

      if (!existingAuth?.id) {
        throw new Error('No patient account was found for that email address.');
      }

      const { error: updateError } = await supabase
        .from('patient_auth')
        .update(updateData)
        .eq('id', existingAuth.id);

      if (updateError) {
        throw new Error(updateError.message);
      }
    },
    
    // Authenticate patient with email, phone, username, or name + password
    authenticate: async (identifier: string, password: string): Promise<Patient | null> => {
      try {
        const trimmedIdentifier = identifier.trim();
        const normalizedIdentifier = normalizePatientUsernameForAuth(trimmedIdentifier) || trimmedIdentifier.toLowerCase();
        type PatientAuthCandidate = {
          patient_id: string;
          password: string | null;
          is_verified?: boolean | null;
          phone?: string | null;
        };
        const findVerifiedPasswordMatch = (rows: PatientAuthCandidate[]): PatientAuthCandidate | null => {
          return rows.find((row) => row.is_verified !== false && row.password === password) || null;
        };
        
        // 1. Try to find patient_auth by email, phone, or username
        const lookupAuthMatch = async (
          column: 'email' | 'phone' | 'username',
          value: string
        ): Promise<PatientAuthCandidate[]> => {
          if (!value) return [];

          const { data, error } = await supabase
            .from('patient_auth')
            .select('patient_id, password, is_verified, created_at')
            .eq(column, value)
            .order('is_verified', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(5);

          if (error) {
            console.warn(`Patient auth lookup error (${column}):`, error.message);
            return [];
          }

          return data || [];
        };

        const lookupPhoneByNormalizedDigits = async (): Promise<PatientAuthCandidate[]> => {
          const normalizedPhoneDigits = normalizePhoneDigitsForLookup(trimmedIdentifier);
          if (!normalizedPhoneDigits) return [];

          const { data, error } = await supabase
            .from('patient_auth')
            .select('patient_id, password, phone, is_verified, created_at')
            .order('is_verified', { ascending: false })
            .order('created_at', { ascending: false });

          if (error) {
            console.warn('Patient auth normalized phone lookup error:', error.message);
            return [];
          }

          return (data || []).filter((record: any) => normalizePhoneDigitsForLookup(record.phone) === normalizedPhoneDigits);
        };

        const normalizedPhone = normalizeMyanmarPhoneForLookup(trimmedIdentifier);
        const authCandidates = [
          ...await lookupAuthMatch('email', normalizedIdentifier),
          ...await lookupAuthMatch('username', normalizedIdentifier),
          ...await lookupAuthMatch('phone', trimmedIdentifier),
          ...await lookupAuthMatch('phone', normalizedPhone || ''),
          ...await lookupPhoneByNormalizedDigits()
        ];
        const authMatch = findVerifiedPasswordMatch(authCandidates);

        if (authCandidates.length > 0) {
          if (!authMatch) {
            const hasVerifiedCandidate = authCandidates.some((candidate) => candidate.is_verified !== false);
            if (!hasVerifiedCandidate) {
              console.log('Patient auth record is not verified yet.');
            } else {
              console.log('Password mismatch for patient_auth records.');
            }
            return null;
          }

          if (authMatch.is_verified === false) {
            console.log('Patient auth record is not verified yet.');
            return null;
          }

          const { data: patientData, error: pError } = await supabase
            .from('patients')
            .select('id, patient_unique_id, location_id, name, email, phone, balance, loyalty_points, medical_history, created_at')
            .eq('id', authMatch.patient_id)
            .maybeSingle();

          if (pError || !patientData) {
            console.log('No patient found for auth record:', authMatch.patient_id);
            return null;
          }

          console.log('Patient authentication successful for:', patientData.name);
          return mapPatient(patientData);
        }

        // 2. Fallback: allow phone login when patient_auth.phone is missing but patients.phone is present.
        const lookupPatientByNormalizedPhone = async (): Promise<Patient | null> => {
          const normalizedPhoneDigits = normalizePhoneDigitsForLookup(trimmedIdentifier);
          if (!normalizedPhoneDigits) return null;

          const { data: patientRows, error: patientRowsError } = await supabase
            .from('patients')
            .select('id, patient_unique_id, location_id, name, email, phone, balance, loyalty_points, medical_history, created_at');

          if (patientRowsError) {
            console.warn('Patient normalized phone lookup error:', patientRowsError.message);
            return null;
          }

          const phonePatient = (patientRows || []).find((record: any) => normalizePhoneDigitsForLookup(record.phone) === normalizedPhoneDigits);
          if (!phonePatient?.id) return null;

          const { data: phoneAuthData, error: phoneAuthError } = await supabase
            .from('patient_auth')
            .select('password, is_verified')
            .eq('patient_id', phonePatient.id)
            .maybeSingle();

          if (phoneAuthError || !phoneAuthData) {
            console.log('No auth record found for phone patient:', phonePatient.name);
            return null;
          }

          if (phoneAuthData.is_verified === false) {
            console.log('Phone patient auth record is not verified yet.');
            return null;
          }

          if (password !== phoneAuthData.password) {
            console.log('Password mismatch for phone patient:', phonePatient.name);
            return null;
          }

          console.log('Patient authentication successful for phone:', phonePatient.name);
          return mapPatient(phonePatient);
        };

        const phonePatient = await lookupPatientByNormalizedPhone();
        if (phonePatient) {
          return phonePatient;
        }

        // 3. Fallback: allow legacy login by patient name
        const { data: patientData, error: pError } = await supabase
          .from('patients')
          .select('id, patient_unique_id, location_id, name, email, phone, balance, loyalty_points, medical_history, created_at')
          .eq('name', trimmedIdentifier)
          .maybeSingle();

        if (pError || !patientData) {
          console.log('No patient found with identifier:', trimmedIdentifier);
          return null;
        }

        const { data: authData, error: aError } = await supabase
          .from('patient_auth')
          .select('password, is_verified')
          .eq('patient_id', patientData.id)
          .maybeSingle();

        if (aError || !authData) {
          console.log('No auth record found for patient:', patientData.name);
          return null;
        }

        if (authData.is_verified === false) {
          console.log('Patient auth record is not verified yet:', patientData.name);
          return null;
        }

        if (password === authData.password) {
          console.log('Patient authentication successful for:', patientData.name);
          return mapPatient(patientData);
        }

        console.log('Password mismatch for patient:', patientData.name);
        return null;
      } catch (err) {
        console.error('Error authenticating patient:', err);
        return null;
      }
    },

    // Register patient with password
    register: async (email: string, password: string, username?: string): Promise<Patient> => {
      // 1. Get first location as default
      const { data: locations } = await supabase.from('locations').select('id').limit(1);
      const defaultLocationId = locations && locations.length > 0 ? locations[0].id : null;

      if (!defaultLocationId) throw new Error('No clinic location found. Please contact admin.');
      const normalizedEmail = email.toLowerCase().trim();
      const normalizedUsername = normalizePatientUsernameForAuth(username);

      // 2. Check if patient already exists
      let { data: existingPatient, error: fetchError } = await supabase
        .from('patients')
        .select('id, name, email, phone, location_id')
        .eq('email', normalizedEmail)
        .single();

      let patient;
      if (fetchError || !existingPatient) {
        // Patient doesn't exist, create new one
        const { data: newPatient, error: pError } = await supabase
          .from('patients')
          .insert({ 
            name: normalizedUsername || normalizedEmail.split('@')[0], 
            email: normalizedEmail,
            location_id: defaultLocationId
          })
          .select()
          .single();

        if (pError) throw new Error(pError.message);
        patient = newPatient;
      } else {
        // Patient already exists, use existing one
        patient = existingPatient;
      }

      // 3. Create or update auth record with user-defined password
      const { error: aError } = await supabase
        .from('patient_auth')
        .upsert({
          patient_id: patient.id,
          location_id: patient.location_id || defaultLocationId,
          username: normalizedUsername,
          email: normalizedEmail,
          phone: patient.phone || null,
          password: password,
          is_verified: true
        });

      if (aError) throw new Error(aError.message);

      return mapPatient(patient);
    },

    // Register patient with Supabase Auth integration
    registerWithSupabase: async (
      email: string, 
      password: string, 
      supabaseUserId?: string,
      username?: string,
      phone?: string,
      isVerified: boolean = true,
      age?: number,
      address?: string,
      city?: string,
      township?: string
    ): Promise<Patient> => {
      // 1. Get first location as default
      const { data: locations } = await supabase.from('locations').select('id').limit(1);
      const defaultLocationId = locations && locations.length > 0 ? locations[0].id : null;

      if (!defaultLocationId) throw new Error('No clinic location found. Please contact admin.');

      const normalizedEmail = email.toLowerCase().trim();
      const normalizedUsername = normalizePatientUsernameForAuth(username);
      const normalizedPhone = normalizePhoneForStorage(phone);

      // 2. Check if patient already exists by email
      let { data: existingPatient, error: fetchError } = await supabase
        .from('patients')
        .select('id, name, email, phone, location_id')
        .eq('email', normalizedEmail)
        .single();

      let patient;
      if (fetchError || !existingPatient) {
        // Patient doesn't exist, create new one
        const { data: newPatient, error: pError } = await supabase
          .from('patients')
          .insert({ 
            name: normalizedUsername || normalizedEmail.split('@')[0], 
            email: normalizedEmail,
            phone: normalizedPhone,
            location_id: defaultLocationId,
            age: age ?? null,
            address: address?.trim() || null,
            city: city?.trim() || null,
            township: township?.trim() || null
          })
          .select()
          .single();

        if (pError) {
          console.error('Error creating patient record:', pError);
          throw new Error(`Failed to create patient: ${pError.message}`);
        }
        patient = newPatient;
      } else {
        // Patient already exists, use existing one
        patient = existingPatient;
      }

      // 3. Check if patient_auth record already exists
      const { data: existingAuth } = await supabase
        .from('patient_auth')
        .select('id')
        .eq('email', normalizedEmail)
        .single();

      if (existingAuth) {
        // Update existing auth record
        const updateData: any = {
          patient_id: patient.id,
          location_id: patient.location_id || defaultLocationId,
          is_verified: isVerified
        };
        if (supabaseUserId) {
          updateData.supabase_user_id = supabaseUserId;
        }
        if (normalizedUsername) {
          updateData.username = normalizedUsername;
        }
        if (normalizedPhone) {
          updateData.phone = normalizedPhone;
        }
        if (password) {
          updateData.password = password;
        }

        const { error: updateError } = await supabase
          .from('patient_auth')
          .update(updateData)
          .eq('email', normalizedEmail);

        if (updateError) {
          console.error('Error updating patient auth record:', updateError);
          throw new Error(`Failed to update authentication: ${updateError.message}`);
        }
      } else {
        // Create new auth record
        const authData: any = {
          patient_id: patient.id,
          location_id: patient.location_id || defaultLocationId,
          username: normalizedUsername,
          email: normalizedEmail,
          phone: normalizedPhone || patient.phone || null,
          is_verified: isVerified,
          password: password || null
        };

        if (supabaseUserId) {
          authData.supabase_user_id = supabaseUserId;
        }

        const { error: insertError } = await supabase
          .from('patient_auth')
          .insert(authData);

        if (insertError) {
          console.error('Error creating patient auth record:', insertError);
          throw new Error(`Failed to create authentication record: ${insertError.message}`);
        }
      }

      console.log('Patient registration completed successfully:', { patientId: patient.id, email: normalizedEmail });
      return mapPatient(patient);
    }
  },

  appointments: {
    getDoctorCorrectionPreview: async (
      appointmentId: string,
      actor: { userId: string; authToken: string }
    ): Promise<DoctorCorrectionPreview> => {
      const { data, error } = await supabase.rpc('preview_visit_doctor_correction', {
        p_appointment_id: trimRequired(appointmentId, 'Appointment'),
        p_admin_user_id: trimRequired(actor.userId, 'Administrator'),
        p_session_token: trimRequired(actor.authToken, 'Administrator session')
      });
      if (error) {
        if (isMissingFunctionError(error, 'preview_visit_doctor_correction')) {
          throw new Error('Doctor correction is not installed. Apply the visit doctor correction migration first.');
        }
        throw new Error(error.message);
      }
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.appointment_id) throw new Error('Doctor correction preview returned no appointment.');
      return result as DoctorCorrectionPreview;
    },
    correctDoctor: async (input: {
      appointmentId: string;
      expectedOldDoctorId?: string | null;
      newDoctorId: string;
      treatmentIds: string[];
      reason: string;
      actor: { userId: string; authToken: string };
      requestToken?: string;
    }): Promise<DoctorCorrectionResult> => {
      const reason = trimRequired(input.reason, 'Correction reason', { maxLength: 1000 });
      if (reason.length < 10) throw new Error('Correction reason must contain at least 10 characters.');
      const { data, error } = await supabase.rpc('correct_visit_doctor_atomic', {
        p_appointment_id: trimRequired(input.appointmentId, 'Appointment'),
        p_expected_old_doctor_id: input.expectedOldDoctorId || null,
        p_new_doctor_id: trimRequired(input.newDoctorId, 'Correct doctor'),
        p_treatment_ids: Array.from(new Set(input.treatmentIds.filter(Boolean))),
        p_reason: reason,
        p_admin_user_id: trimRequired(input.actor.userId, 'Administrator'),
        p_session_token: trimRequired(input.actor.authToken, 'Administrator session'),
        p_request_token: input.requestToken || generateRequestUuid()
      });
      if (error) {
        if (isMissingFunctionError(error, 'correct_visit_doctor_atomic')) {
          throw new Error('Doctor correction is not installed. Apply the visit doctor correction migration first.');
        }
        throw new Error(error.message);
      }
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.correction_id) throw new Error('Doctor correction returned no result.');
      return result as DoctorCorrectionResult;
    },
    list: async (
      locationId: string | undefined,
      options: {
        date?: string;
        dateFrom?: string;
        dateTo?: string;
        page?: number;
        pageSize?: number;
        search?: string;
        doctorIds?: string[];
        treatment?: string;
      } = {}
    ): Promise<{ appointments: Appointment[]; total: number }> => {
      const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 1000);
      const page = Math.max(options.page || 1, 1);
      const safeTerm = (value: string) => value.replace(/[%,_(),]/g, ' ').trim();
      const search = safeTerm(options.search || '');
      const treatment = safeTerm(options.treatment || '');

      let matchingPatientIds: string[] = [];
      if (search) {
        let patientQuery = supabase.from('patients').select('id').ilike('name', `%${search}%`).limit(1000);
        if (locationId) patientQuery = patientQuery.eq('location_id', locationId);
        const { data, error } = await patientQuery;
        if (error) throw error;
        matchingPatientIds = (data || []).map((patient: any) => patient.id);
      }

      const buildQuery = (withRelations: boolean) => {
        let query = supabase
          .from('appointments')
          .select(withRelations ? '*, patients!appointments_patient_id_fkey(name, balance), doctors(name)' : '*', { count: 'exact' })
          .order('date')
          .order('time')
          .order('id')
          .range((page - 1) * pageSize, page * pageSize - 1);

        if (locationId) query = query.eq('location_id', locationId);
        if (options.date) query = query.eq('date', options.date);
        if (options.dateFrom) query = query.gte('date', options.dateFrom);
        if (options.dateTo) query = query.lte('date', options.dateTo);
        if (options.doctorIds?.length) query = query.in('doctor_id', options.doctorIds);
        if (treatment) query = query.or(`type.ilike.%${treatment}%,notes.ilike.%${treatment}%`);
        if (search) {
          const filters = [
            `guest_name.ilike.%${search}%`,
            `guest_phone.ilike.%${search}%`,
            `guest_source.ilike.%${search}%`,
            `guest_notes.ilike.%${search}%`,
            `type.ilike.%${search}%`,
            `notes.ilike.%${search}%`,
            `date.ilike.%${search}%`,
            `time.ilike.%${search}%`,
            `status.ilike.%${search}%`
          ];
          if (matchingPatientIds.length) filters.push(`patient_id.in.(${matchingPatientIds.join(',')})`);
          query = query.or(filters.join(','));
        }
        return query;
      };

      let { data, error, count } = await buildQuery(true);
      if (error && isOptionalRelationAccessError(error, ['patients', 'doctors'])) {
        ({ data, error, count } = await buildQuery(false));
      }
      if (error) throw error;

      return {
        appointments: (data || []).map((apt: any) => ({
          ...apt,
          patient_name: apt.patients?.name || apt.guest_name || 'Unknown',
          patient_balance: apt.patients?.balance ?? null,
          doctor_name: getAppointmentDoctorDisplayName(apt)
        })),
        total: count || 0
      };
    },
    getAll: async (locationId?: string, options?: {
      dateFrom?: string;
      dateTo?: string;
      doctorId?: string;
      throwOnError?: boolean;
    }): Promise<Appointment[]> => {
      try {
        const pageSize = 1000;
        const appointments: any[] = [];

        for (let offset = 0; ; offset += pageSize) {
          const buildQuery = (withRelations: boolean) => {
            let query = supabase
              .from('appointments')
              .select(withRelations ? '*, patients!appointments_patient_id_fkey(name, balance), doctors(name)' : '*')
              .order('date')
              .order('id')
              .range(offset, offset + pageSize - 1);

            if (locationId) query = query.eq('location_id', locationId);
            if (options?.dateFrom) query = query.gte('date', options.dateFrom);
            if (options?.dateTo) query = query.lte('date', options.dateTo);
            if (options?.doctorId) query = query.eq('doctor_id', options.doctorId);
            return query;
          };

          let { data, error } = await buildQuery(true);
          if (error && isOptionalRelationAccessError(error, ['patients', 'doctors'])) {
            ({ data, error } = await buildQuery(false));
          }
          if (error) throw error;

          const page = data || [];
          appointments.push(...page);
          if (page.length < pageSize) break;
        }
        const completedAppointments = appointments.filter(
          (apt: any) => apt.status === 'Completed' && apt.patient_id && apt.date
        );

        const treatmentDoctorByPatientAndDate = new Map<string, string>();

        if (completedAppointments.length > 0) {
          const patientIds = [...new Set(completedAppointments.map((apt: any) => apt.patient_id).filter(Boolean))];
          const dates = [...new Set(completedAppointments.map((apt: any) => apt.date).filter(Boolean))];

          if (patientIds.length > 0 && dates.length > 0) {
            try {
              const patientIdChunks: string[][] = [];
              for (let i = 0; i < patientIds.length; i += 40) {
                patientIdChunks.push(patientIds.slice(i, i + 40));
              }

              const treatmentGroups = await Promise.all(patientIdChunks.map(async (patientIdChunk) => {
                let treatmentsQuery = supabase
                  .from('treatments')
                  .select('patient_id, date, created_at, doctors(name)')
                  .in('patient_id', patientIdChunk)
                  .in('date', dates)
                  .not('doctor_id', 'is', null)
                  .order('created_at', { ascending: false });

                if (locationId) {
                  treatmentsQuery = treatmentsQuery.eq('location_id', locationId);
                }

                const { data: treatments, error: treatmentsError } = await treatmentsQuery;

                if (treatmentsError) {
                  throw treatmentsError;
                }

                return treatments || [];
              }));

              treatmentGroups.flat().forEach((record: any) => {
                const doctorName = getTrimmedDoctorName(record.doctors?.name);
                if (!doctorName) return;

                const key = `${record.patient_id}::${record.date}`;
                if (!treatmentDoctorByPatientAndDate.has(key)) {
                  treatmentDoctorByPatientAndDate.set(key, doctorName);
                }
              });
            } catch (treatmentsError) {
              console.warn('Could not enrich completed appointments with treatment doctor names. Showing appointments without that enrichment.', treatmentsError);
            }
          }
        }

        // Flatten the response to match the Appointment interface
        return appointments.map((apt: any) => ({
          ...apt,
          patient_name: apt.patients?.name || apt.guest_name || 'Unknown',
          patient_balance: apt.patients?.balance ?? null,
          doctor_name: getAppointmentDoctorDisplayName(
            apt,
            apt.patient_id ? treatmentDoctorByPatientAndDate.get(`${apt.patient_id}::${apt.date}`) : undefined
          )
        }));
      } catch (err) {
        console.warn("Error fetching appointments:", err);
        if (options?.throwOnError) throw err;
        return [];
      }
    },
    create: async (data: Partial<Appointment>): Promise<Appointment> => {
      if (!data.location_id) throw new Error('location_id is required');
      const hasRegisteredPatient = !!data.patient_id;
      const guestName = (data.guest_name || '').trim();
      const guestPhone = (data.guest_phone || '').trim();
      const hasGuestContact = !!guestName && !!guestPhone;
      if (!hasRegisteredPatient && !hasGuestContact) {
        throw new Error('Select a registered patient or enter a new patient name and phone number.');
      }
      if (!data.date) throw new Error('date is required');
      if (!data.time) throw new Error('time is required');
      if (!data.type) throw new Error('type is required');

      const requestedStatus = data.status || 'Scheduled';
      const payload = {
        location_id: data.location_id,
        patient_id: data.patient_id || null,
        doctor_id: data.doctor_id && String(data.doctor_id).trim() !== '' ? data.doctor_id : null,
        date: data.date,
        time: data.time,
        type: data.type,
        status: requestedStatus === 'Completed' ? 'Scheduled' : requestedStatus,
        notes: data.notes,
        guest_name: hasRegisteredPatient ? null : guestName,
        guest_phone: hasRegisteredPatient ? null : guestPhone,
        guest_source: hasRegisteredPatient ? null : (data.guest_source || '').trim() || null,
        guest_notes: hasRegisteredPatient ? null : (data.guest_notes || '').trim() || null,
        converted_patient_id: data.converted_patient_id || null,
        created_by_user_id: data.created_by_user_id || null,
        created_by_user_name: data.created_by_user_name || null
      };

      let { data: result, error } = await supabase
        .from('appointments')
        .insert(payload)
        .select('*')
        .single();

      if (error && /created_by_user_(id|name)/i.test(error.message || '')) {
        const legacyPayload = { ...payload };
        delete (legacyPayload as any).created_by_user_id;
        delete (legacyPayload as any).created_by_user_name;

        const legacyInsert = await supabase
          .from('appointments')
          .insert(legacyPayload)
          .select('*')
          .single();

        result = legacyInsert.data;
        error = legacyInsert.error;
      }

      if (error) {
        if (error.code === '23503') throw new Error('Invalid Patient or Doctor ID');
        throw new Error(error.message);
      }

      if (requestedStatus === 'Completed') {
        await completeAppointmentWithClinicalFee(result.id);
        result = await fetchAppointmentPrimaryById(result.id);
      }
      
      // Flatten the response
      return {
        ...result,
        patient_name: result.patients?.name || result.guest_name || 'Unknown',
        patient_balance: result.patients?.balance ?? null,
        doctor_name: result.doctors?.name || undefined
      };
    },
    updateStatus: async (
      id: string,
      status: string,
      options: { skipClinicalFee?: boolean } = {}
    ): Promise<ClinicalFeeCompletionResult | void> => {
      const { data: appointment, error: fetchError } = await supabase
        .from('appointments')
        .select('id, patient_id, location_id, status, clinical_fee_status')
        .eq('id', id)
        .single();

      if (fetchError || !appointment) {
        if (fetchError && isMissingColumnError(fetchError, 'clinical_fee_status')) {
          throw new Error('Per-visit clinical fees are not installed. Run database/clinical_fee_per_visit_migration.sql in Supabase.');
        }
        throw new Error(fetchError?.message || 'Appointment not found');
      }

      if (status === 'Completed') {
        const result = await completeAppointmentWithClinicalFee(id, Boolean(options.skipClinicalFee));

        return result;
      }

      if (appointment.status === 'Completed' && appointment.clinical_fee_status === 'APPLIED') {
        throw new Error('This completed visit has an applied clinical fee and cannot be reopened without a financial adjustment.');
      }

      const { error } = await supabase
        .from('appointments')
        .update({ status })
        .eq('id', id);

      if (error) throw new Error(error.message);
    },
    updateCancellationOutcome: async (
      id: string,
      outcome: CancellationOutcome | null,
      completedLaterAppointmentId?: string | null
    ): Promise<Appointment> => {
      const { data: cancelledAppointment, error: cancelledAppointmentError } = await supabase
        .from('appointments')
        .select('id, patient_id, date, time, status')
        .eq('id', id)
        .single();

      if (cancelledAppointmentError || !cancelledAppointment) {
        if (cancelledAppointmentError && isMissingColumnError(cancelledAppointmentError, 'cancellation_outcome')) {
          throw new Error('Cancellation follow-up outcomes are not installed. Run database/cancellation_follow_up_outcomes_migration.sql in Supabase.');
        }
        throw new Error(cancelledAppointmentError?.message || 'Cancelled appointment not found.');
      }

      if (cancelledAppointment.status !== 'Cancelled') {
        throw new Error('Only cancelled appointments can have a follow-up outcome.');
      }

      const allowedOutcomes: Array<CancellationOutcome | null> = [null, 'NO_SHOW', 'RESCHEDULED', 'COMPLETED_LATER'];
      if (!allowedOutcomes.includes(outcome)) {
        throw new Error('Invalid cancellation follow-up outcome.');
      }

      let linkedCompletedAppointmentId: string | null = null;
      if (outcome === 'COMPLETED_LATER') {
        if (!completedLaterAppointmentId || !cancelledAppointment.patient_id) {
          throw new Error('Choose a later completed appointment for this registered patient.');
        }

        const { data: completedAppointment, error: completedAppointmentError } = await supabase
          .from('appointments')
          .select('id, patient_id, date, time, status')
          .eq('id', completedLaterAppointmentId)
          .single();

        if (completedAppointmentError || !completedAppointment) {
          throw new Error(completedAppointmentError?.message || 'Later completed appointment not found.');
        }

        const toAppointmentDateTimeKey = (appointment: { date: string; time?: string | null }) =>
          `${appointment.date}T${String(appointment.time || '00:00').slice(0, 5).padEnd(5, '0')}`;
        const cancelledDateTime = toAppointmentDateTimeKey(cancelledAppointment);
        const completedDateTime = toAppointmentDateTimeKey(completedAppointment);
        if (
          completedAppointment.status !== 'Completed' ||
          completedAppointment.patient_id !== cancelledAppointment.patient_id ||
          completedDateTime <= cancelledDateTime
        ) {
          throw new Error('The linked appointment must be a later completed appointment for the same patient.');
        }
        linkedCompletedAppointmentId = completedAppointment.id;
      }

      const { data: result, error } = await supabase
        .from('appointments')
        .update({
          cancellation_outcome: outcome,
          completed_later_appointment_id: linkedCompletedAppointmentId
        })
        .eq('id', id)
        .select('*')
        .single();

      if (error) {
        if (isMissingColumnError(error, 'cancellation_outcome')) {
          throw new Error('Cancellation follow-up outcomes are not installed. Run database/cancellation_follow_up_outcomes_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }
      return result as Appointment;
    },
    update: async (
      id: string,
      data: Partial<Appointment>,
      options?: {
        rescheduleAudit?: {
          reason: string;
          adminUserId?: string | null;
          adminName?: string | null;
        };
      }
    ): Promise<Appointment> => {
      const { data: existingAppointment, error: existingAppointmentError } = await supabase
        .from('appointments')
        .select('status, clinical_fee_status, patient_id, location_id, date, time, guest_name, doctor_id, patients!appointments_patient_id_fkey(name)')
        .eq('id', id)
        .single();

      if (existingAppointmentError) {
        if (isMissingColumnError(existingAppointmentError, 'clinical_fee_status')) {
          throw new Error('Per-visit clinical fees are not installed. Run database/clinical_fee_per_visit_migration.sql in Supabase.');
        }
        throw new Error(existingAppointmentError.message);
      }

      const shouldComplete = data.status === 'Completed';
      if (
        !shouldComplete &&
        data.status !== undefined &&
        existingAppointment.status === 'Completed' &&
        existingAppointment.clinical_fee_status === 'APPLIED'
      ) {
        throw new Error('This completed visit has an applied clinical fee and cannot be reopened without a financial adjustment.');
      }

      if (existingAppointment.clinical_fee_status === 'APPLIED') {
        const changesFeeIdentity =
          (data.patient_id !== undefined && (data.patient_id || null) !== existingAppointment.patient_id) ||
          (data.location_id !== undefined && data.location_id !== existingAppointment.location_id) ||
          (data.date !== undefined && data.date !== existingAppointment.date) ||
          (data.time !== undefined && data.time !== existingAppointment.time);

        if (changesFeeIdentity) {
          throw new Error('This visit has an applied clinical fee. Patient, branch, date, and time cannot be changed without a financial adjustment.');
        }
      }

      const appointmentDataWithoutDoctor = excludeProtectedDoctorChange(
        data as Partial<Appointment> & Record<string, unknown>,
        existingAppointment.doctor_id
      );

      const {
        guest_email: _guestEmail,
        guest_age: _guestAge,
        guest_address: _guestAddress,
        guest_password: _guestPassword,
        ...appointmentData
      } = appointmentDataWithoutDoctor as Partial<Appointment> & {
        guest_email?: unknown;
        guest_age?: unknown;
        guest_address?: unknown;
        guest_password?: unknown;
      };

      const updatePayload = {
        ...appointmentData,
        status: shouldComplete ? undefined : data.status,
        patient_id: Object.prototype.hasOwnProperty.call(data, 'patient_id')
          ? (data.patient_id || null)
          : undefined
      };

      let { data: result, error } = await supabase
        .from('appointments')
        .update(updatePayload)
        .eq('id', id)
        .select('*')
        .single();

      if (error) throw new Error(error.message);

      const originalDate = existingAppointment.date;
      const newDate = data.date ?? result.date;
      const shouldCreateRescheduleAudit = Boolean(
        options?.rescheduleAudit &&
        originalDate &&
        newDate &&
        originalDate !== newDate
      );

      if (shouldCreateRescheduleAudit) {
        const patientName =
          getJoinedOne(existingAppointment.patients)?.name ||
          result.guest_name ||
          existingAppointment.guest_name ||
          'Unknown';
        let doctorName: string | null = null;
        const auditDoctorId = result.doctor_id || existingAppointment.doctor_id;
        if (auditDoctorId) {
          const { data: doctorRow, error: doctorNameError } = await supabase
            .from('doctors')
            .select('name')
            .eq('id', auditDoctorId)
            .maybeSingle();
          if (!doctorNameError) {
            doctorName = getTrimmedDoctorName(doctorRow?.name) || null;
          }
        }

        await api.appointmentRescheduleLogs.create({
          appointment_id: result.id,
          location_id: result.location_id,
          patient_id: result.patient_id || existingAppointment.patient_id || null,
          patient_name: patientName,
          doctor_name: doctorName,
          original_date: originalDate,
          new_date: newDate,
          reason: options?.rescheduleAudit?.reason || '',
          admin_user_id: options?.rescheduleAudit?.adminUserId || null,
          admin_name: options?.rescheduleAudit?.adminName || null
        });
      }

      if (shouldComplete) {
        await completeAppointmentWithClinicalFee(id);
        result = await fetchAppointmentPrimaryById(id);
      }
      
      // Flatten the response
      return {
        ...result,
        patient_name: getJoinedOne(result.patients)?.name || result.guest_name || 'Unknown',
        patient_balance: getJoinedOne(result.patients)?.balance ?? null,
        doctor_name: getJoinedOne(result.doctors)?.name || undefined
      };
    },
    delete: async (id: string): Promise<void> => {
      const { data: appointment, error: appointmentError } = await supabase
        .from('appointments')
        .select('clinical_fee_status')
        .eq('id', id)
        .single();

      if (appointmentError) {
        if (isMissingColumnError(appointmentError, 'clinical_fee_status')) {
          throw new Error('Per-visit clinical fees are not installed. Run database/clinical_fee_per_visit_migration.sql in Supabase.');
        }
        throw new Error(appointmentError.message);
      }

      if (appointment.clinical_fee_status === 'APPLIED') {
        throw new Error('This visit has an applied clinical fee and cannot be deleted without a financial adjustment.');
      }

      const { error } = await supabase
        .from('appointments')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
    },
    cleanupOld: async (daysOld: number = 4, locationId?: string): Promise<number> => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

      let query = supabase
        .from('appointments')
        .delete()
        .lt('date', cutoffDateStr)
        .neq('clinical_fee_status', 'APPLIED')
        .select();

      if (locationId) {
        query = query.eq('location_id', locationId);
      }

      const { data, error } = await query;

      if (error) throw new Error(error.message);
      
      // Return count of deleted records
      return data?.length || 0;
    }
  },

  appointmentRescheduleLogs: {
    getAll: async (locationId?: string, options?: {
      dateFrom?: string;
      dateTo?: string;
      throwOnError?: boolean;
    }): Promise<AppointmentRescheduleLog[]> => {
      try {
        const { data, error } = await fetchAllRows<any>((from, to) => {
          let query = supabase
            .from('appointment_reschedule_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .order('id')
            .range(from, to);
          if (locationId) query = query.eq('location_id', locationId);
          if (options?.dateFrom) query = query.gte('created_at', getLocalDateBoundaryISO(options.dateFrom));
          if (options?.dateTo) query = query.lt('created_at', getLocalDateBoundaryISO(options.dateTo, 1));
          return query;
        });
        if (error) {
          if (isMissingRelationError(error, 'appointment_reschedule_logs')) {
            return [];
          }
          throw error;
        }

        return (data || []).map(mapAppointmentRescheduleLog);
      } catch (error: any) {
        if (isMissingRelationError(error, 'appointment_reschedule_logs')) {
          return [];
        }
        console.warn('Failed to load appointment reschedule logs:', error?.message || error);
        if (options?.throwOnError) throw error;
        return [];
      }
    },

    create: async (data: Omit<AppointmentRescheduleLog, 'id' | 'created_at'>): Promise<AppointmentRescheduleLog> => {
      const payload = {
        appointment_id: data.appointment_id,
        location_id: data.location_id,
        patient_id: data.patient_id || null,
        patient_name: (data.patient_name || '').trim() || 'Unknown',
        doctor_name: data.doctor_name?.trim() || null,
        original_date: data.original_date,
        new_date: data.new_date,
        reason: (data.reason || '').trim(),
        admin_user_id: data.admin_user_id || null,
        admin_name: data.admin_name?.trim() || null
      };

      if (!payload.reason) {
        throw new Error('Reschedule reason is required.');
      }

      let { data: result, error } = await supabase
        .from('appointment_reschedule_logs')
        .insert(payload)
        .select('*')
        .single();

      if (error && /appointment_reschedule_logs_admin_user_id_fkey/i.test(error.message || '')) {
        const retry = await supabase
          .from('appointment_reschedule_logs')
          .insert({ ...payload, admin_user_id: null })
          .select('*')
          .single();
        result = retry.data;
        error = retry.error;
      }

      if (error) {
        if (isMissingRelationError(error, 'appointment_reschedule_logs')) {
          throw new Error('Appointment reschedule audit is not installed. Run database/appointment_reschedule_audit_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }

      return mapAppointmentRescheduleLog(result);
    },

    update: async (
      id: string,
      data: Partial<Pick<AppointmentRescheduleLog, 'original_date' | 'new_date' | 'reason' | 'doctor_name'>>
    ): Promise<AppointmentRescheduleLog> => {
      const payload = {
        original_date: data.original_date,
        new_date: data.new_date,
        reason: data.reason?.trim(),
        doctor_name: data.doctor_name?.trim() || null
      };

      if (payload.reason !== undefined && !payload.reason) {
        throw new Error('Reschedule reason is required.');
      }

      const { data: result, error } = await supabase
        .from('appointment_reschedule_logs')
        .update(payload)
        .eq('id', id)
        .select('*')
        .single();

      if (error) throw new Error(error.message);

      return mapAppointmentRescheduleLog(result);
    }
  },

  materialCosts: {
    getPresets: async (
      actor: { userId: string; authToken: string }
    ): Promise<{ presets: MaterialLabCostPreset[]; revision: number }> => {
      const userId = trimRequired(actor.userId, 'Staff user');
      const authToken = trimRequired(actor.authToken, 'Staff session');
      const { data, error } = await supabase.rpc('get_material_lab_cost_presets', {
        p_user_id: userId,
        p_session_token: authToken
      });

      if (error) {
        if (isMissingRpcError(error, 'get_material_lab_cost_presets')) {
          throw new Error('Cost presets are not installed yet. Run database/material_lab_cost_presets_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }

      const payload = data && !Array.isArray(data) ? data : {};
      const rows = Array.isArray(payload.presets) ? payload.presets : [];
      return {
        presets: sortMaterialCostPresets(rows.map(mapMaterialLabCostPresetRow)),
        revision: Math.max(0, Number(payload.revision || 0))
      };
    },

    replacePresets: async (
      presets: MaterialLabCostPresetInput[],
      expectedRevision: number,
      actor: { userId: string; authToken: string }
    ): Promise<{ presets: MaterialLabCostPreset[]; revision: number }> => {
      const userId = trimRequired(actor.userId, 'Staff user');
      const authToken = trimRequired(actor.authToken, 'Staff session');
      const normalized = normalizeMaterialCostPresetInputs(presets);
      const revision = finiteNumber(expectedRevision, 'Preset revision', { min: 0 });
      const { data, error } = await supabase.rpc('replace_material_lab_cost_presets', {
        p_items: normalized.map((preset) => ({
          id: preset.id,
          cost_type: preset.costType,
          label: preset.label,
          amount: preset.amount,
          sort_order: preset.sortOrder
        })),
        p_expected_revision: revision,
        p_user_id: userId,
        p_session_token: authToken
      });

      if (error) {
        const message = String(error.message || '');
        if (isMissingRpcError(error, 'replace_material_lab_cost_presets')) {
          throw new Error('Cost presets are not installed yet. Run database/material_lab_cost_presets_migration.sql in Supabase.');
        }
        if (message.includes('Preset list changed')) {
          throw new Error('Preset list changed on another device. Reload presets before saving again.');
        }
        throw new Error(message);
      }

      const payload = data && !Array.isArray(data) ? data : {};
      const rows = Array.isArray(payload.presets) ? payload.presets : [];
      return {
        presets: sortMaterialCostPresets(rows.map(mapMaterialLabCostPresetRow)),
        revision: Math.max(0, Number(payload.revision || revision + 1))
      };
    },

    getTotalsByTreatmentIds: async (
      treatmentIds: string[],
      options?: { onProgress?: (completed: number, total: number) => void; requireCostTables?: boolean; idBatchSize?: number }
    ): Promise<Record<string, TreatmentCostSummary>> => {
      const uniqueIds = Array.from(new Set(treatmentIds.filter(Boolean)));
      if (uniqueIds.length === 0) return {};

      try {
        const auditIdBatches = chunkUniqueIds(uniqueIds, options?.idBatchSize);
        const auditBatches = await mapWithConcurrency(auditIdBatches, REPORT_REQUEST_CONCURRENCY, async (idBatch) => {
          const { data, error: auditLogError } = await supabase
            .from('audit_logs')
            .select('id, source_id')
            .eq('source_type', 'treatment')
            .in('source_id', idBatch);

          if (auditLogError) {
            if (isMissingRelationError(auditLogError, 'audit_logs')) {
              if (options?.requireCostTables) throw new Error('Monthly Report cost data is unavailable because audit log storage is not installed.');
              return [];
            }
            throw auditLogError;
          }

          return data || [];
        }, (completed, total) => {
          options?.onProgress?.(Math.round((completed / Math.max(total, 1)) * 50), 100);
        });
        const auditRows: any[] = auditBatches.flat();

        const auditIds = auditRows.map((row: any) => row.id).filter(Boolean);
        if (auditIds.length === 0) {
          options?.onProgress?.(1, 1);
          return {};
        }

        const materialIdBatches = chunkUniqueIds(auditIds, options?.idBatchSize);
        const materialBatches = await mapWithConcurrency(materialIdBatches, REPORT_REQUEST_CONCURRENCY, async (auditIdBatch) => {
          let { data, error: materialError } = await supabase
            .from('patient_material_costs')
            .select('audit_log_id, cost_type, total_amount')
            .in('audit_log_id', auditIdBatch);

          if (materialError && isMissingColumnError(materialError, 'cost_type')) {
            const legacyResult = await supabase
              .from('patient_material_costs')
              .select('audit_log_id, total_amount')
              .in('audit_log_id', auditIdBatch);
            data = (legacyResult.data || []).map((row: any) => ({ ...row, cost_type: 'material' }));
            materialError = legacyResult.error;
          }

          if (materialError) {
            if (isMissingRelationError(materialError, 'patient_material_costs')) {
              if (options?.requireCostTables) throw new Error('Monthly Report cost data is unavailable because material and lab cost storage is not installed.');
              return [];
            }
            throw materialError;
          }

          return data || [];
        }, (completed, total) => {
          options?.onProgress?.(50 + Math.round((completed / Math.max(total, 1)) * 50), 100);
        });
        const materialRows: any[] = materialBatches.flat();

        const sourceByAuditId = new Map(auditRows.map((row: any) => [row.id, row.source_id]));
        return summarizeTreatmentCostRows(materialRows, sourceByAuditId);
      } catch (err) {
        console.warn('Error fetching material cost totals:', err);
        throw err;
      }
    },

    getByTreatmentId: async (treatmentId: string): Promise<{ auditLogId: string | null; items: PatientMaterialCost[] }> => {
      const { data: auditLog, error: auditLogError } = await supabase
        .from('audit_logs')
        .select('id')
        .eq('source_type', 'treatment')
        .eq('source_id', treatmentId)
        .maybeSingle();

      if (auditLogError) {
        if (isMissingRelationError(auditLogError, 'audit_logs')) {
          throw new Error('Material cost tables are not installed yet. Run database/patient_material_costs_migration.sql first.');
        }
        throw new Error(auditLogError.message);
      }

      if (!auditLog?.id) {
        return { auditLogId: null, items: [] };
      }

      const { data, error } = await supabase
        .from('patient_material_costs')
        .select('*, users(username)')
        .eq('audit_log_id', auditLog.id)
        .order('created_at', { ascending: true });

      if (error) throw new Error(error.message);
      return {
        auditLogId: auditLog.id,
        items: (data || []).map(mapPatientMaterialCostRow)
      };
    },

    upsertForTreatment: async (
      treatment: ClinicalRecord,
      items: PatientMaterialCostInput[],
      createdBy?: { userId?: string | null; username?: string | null; authToken?: string }
    ): Promise<{ auditLogId: string; items: PatientMaterialCost[]; commissionRefreshPending: boolean }> => {
      const treatmentId = trimRequired(treatment.id, 'Treatment audit row');
      const normalizedItems = items
        .map((item) => ({
          material_name: trimRequired(item.materialName, item.costType === 'lab' ? 'Lab cost name' : item.costType === 'special_doctor' ? 'Special doctor name' : 'Material name', { maxLength: 255 }),
          cost_type: enumValue(item.costType, ['material', 'lab', 'special_doctor'] as const, 'Cost type'),
          cost_amount: finiteNumber(item.costAmount, item.costType === 'lab' ? 'Lab cost' : item.costType === 'special_doctor' ? 'Special doctor cost' : 'Material cost', { min: 0.01 }),
          quantity: finiteNumber(item.quantity, item.costType === 'lab' ? 'Lab quantity' : item.costType === 'special_doctor' ? 'Special doctor quantity' : 'Material quantity', { min: 0.01 })
        }))
        .filter((item) => item.material_name);

      const auditPayload = {
        source_type: 'treatment' as AuditLogSourceType,
        source_id: treatmentId,
        location_id: treatment.location_id || null,
        patient_id: treatment.patient_id || null,
        doctor_id: treatment.doctor_id || null,
        treatment_id: treatmentId
      };

      const { data: auditLog, error: auditLogError } = await supabase
        .from('audit_logs')
        .upsert(auditPayload, { onConflict: 'source_type,source_id' })
        .select('id')
        .single();

      if (auditLogError) {
        if (isMissingRelationError(auditLogError, 'audit_logs')) {
          throw new Error('Material cost tables are not installed yet. Run database/patient_material_costs_migration.sql first.');
        }
        throw new Error(auditLogError.message);
      }

      const auditLogId = auditLog.id;
      const requestToken = generateRequestUuid();
      const { data, error: replaceError } = await supabase.rpc('replace_treatment_costs', {
        p_audit_log_id: auditLogId,
        p_items: normalizedItems,
        p_admin_user_id: createdBy?.userId || null,
        // The legacy parameter name is retained for rolling-deployment compatibility.
        p_admin_password: createdBy?.authToken || '',
        p_request_token: requestToken
      });
      if (replaceError) {
        if (isMissingRelationError(replaceError, 'replace_treatment_costs') || String(replaceError.message || '').includes('replace_treatment_costs')) {
          throw new Error('Treatment Costs migration is not installed yet. Run the latest Supabase migrations first.');
        }
        throw new Error(replaceError.message);
      }

      let commissionRefreshPending = false;
      try {
        await processPendingCommissionRecalculation(treatment.patient_id, requestToken, {
          userId: createdBy?.userId || '',
          authToken: createdBy?.authToken || ''
        });
      } catch (commissionError) {
        commissionRefreshPending = true;
        console.error('Treatment costs were saved, but doctor commission refresh needs retry.', commissionError);
      }

      return {
        auditLogId,
        items: data.map(mapPatientMaterialCostRow),
        commissionRefreshPending
      };
    }
  },

  treatments: {
    // Configuration
    getTypes: async (locationId?: string): Promise<TreatmentType[]> => {
       try {
         let query = supabase
           .from('treatment_types')
           .select('*')
           .order('category', { ascending: true });
         
         if (locationId) {
           query = query.eq('location_id', locationId);
         }

         const { data, error } = await query;
         
         if (error) throw error;
         return data || [];
       } catch (err) {
         console.warn("Error fetching treatment types:", err);
         return [];
       }
    },
    createType: async (data: Partial<TreatmentType>): Promise<TreatmentType> => {
      const { data: result, error } = await supabase
        .from('treatment_types')
        .insert(data)
        .select()
        .single();
        
      if (error) throw new Error(error.message);
      return result;
    },
    updateType: async (id: string, data: Partial<TreatmentType>): Promise<TreatmentType> => {
      const { data: result, error } = await supabase
        .from('treatment_types')
        .update(data)
        .eq('id', id)
        .select()
        .single();
        
      if (error) throw new Error(error.message);
      return result;
    },
    deleteType: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('treatment_types')
        .delete()
        .eq('id', id);
        
      if (error) throw new Error(error.message);
    },

    // Execution
    getHistory: async (
      patientId: string,
      options?: { includeCommissionEntries?: boolean }
    ): Promise<ClinicalRecord[]> => {
      let { data, error } = await supabase
        .from('treatments')
        .select('*, doctors(name, specialization, commission_type, commission_percentage, commission_per_visit)')
        .eq('patient_id', patientId)
        .order('date', { ascending: false });

      if (error && isMissingColumnError(error, 'commission_type')) {
        const fallback = await supabase
          .from('treatments')
          .select('*, doctors(name, specialization, commission_percentage, commission_per_visit)')
          .eq('patient_id', patientId)
          .order('date', { ascending: false });
        data = fallback.data;
        error = fallback.error;
      }

      if (error && isOptionalRelationAccessError(error, ['doctors'])) {
        const fallback = await supabase
          .from('treatments')
          .select('*')
          .eq('patient_id', patientId)
          .order('date', { ascending: false });
        data = fallback.data;
        error = fallback.error;
      }

      if (error) throw new Error(error.message);
      const entriesByTreatment = options?.includeCommissionEntries === false
        ? new Map<string, any[]>()
        : await getDoctorEarningEntriesByTreatmentIds((data || []).map((rec: any) => rec.id));
      return (data || []).map((rec: any) => ({
        ...rec,
        standardCost: rec.standard_cost ?? null,
        discountAmount: Number(rec.discount_amount || 0),
        pricingNote: rec.pricing_note || null,
        doctorEarnings: Number(rec.doctor_earnings || 0),
        doctorEarningEntries: entriesByTreatment.get(rec.id) || (
          Number(rec.doctor_earnings || 0) > 0 && rec.doctor_id
            ? [{
                paymentId: `legacy-${rec.id}`,
                treatmentId: rec.id,
                doctorId: rec.doctor_id,
                paymentDate: rec.date,
                treatmentDate: rec.date,
                calculationMode: usesFlatVisitCommission({
                  commissionType: rec.commission_type_snapshot ?? rec.doctors?.commission_type,
                  specialization: rec.doctors?.specialization
                }) ? 'flat_visit' : 'percentage',
                allocatedPayment: Number(rec.cost || 0),
                commissionRate: Number((usesFlatVisitCommission({
                  commissionType: rec.commission_type_snapshot ?? rec.doctors?.commission_type,
                  specialization: rec.doctors?.specialization
                }) ? (rec.commission_per_visit_snapshot ?? rec.doctors?.commission_per_visit) : (rec.commission_percentage_snapshot ?? rec.doctors?.commission_percentage)) || 0),
                earnings: Number(rec.doctor_earnings || 0)
              }]
            : []
        ),
        doctor_name: rec.doctors?.name || undefined,
        doctor_specialization: rec.doctors?.specialization || null,
        doctor_commission_type: resolveDoctorCommissionType({
          commissionType: rec.commission_type_snapshot ?? rec.doctors?.commission_type,
          specialization: rec.doctors?.specialization
        }),
        doctor_commission_percentage: rec.commission_percentage_snapshot !== undefined && rec.commission_percentage_snapshot !== null
          ? Number(rec.commission_percentage_snapshot)
          : rec.doctors?.commission_percentage !== undefined ? Number(rec.doctors.commission_percentage || 0) : null,
        doctor_commission_per_visit: rec.commission_per_visit_snapshot !== undefined && rec.commission_per_visit_snapshot !== null
          ? Number(rec.commission_per_visit_snapshot)
          : rec.doctors?.commission_per_visit !== undefined ? Number(rec.doctors.commission_per_visit || 0) : null,
        doctor_commission_source: rec.commission_source_snapshot || null,
        doctor_commission_snapshot_at: rec.commission_snapshot_at || null
      }));
    },
    getAnalysisRecords: async ({
      locationId,
      dateFrom,
      dateTo,
      onProgress
    }: {
      locationId?: string;
      dateFrom: string;
      dateTo: string;
      onProgress?: (completed: number, total: number) => void;
    }): Promise<ClinicalRecord[]> => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
        throw new Error('A valid treatment analysis date range is required.');
      }

      const pageSize = 1000;
      const records: ClinicalRecord[] = [];

      for (let offset = 0; ; offset += pageSize) {
        let query = supabase
          .from('treatments')
          .select('id, location_id, patient_id, doctor_id, treatment_type_id, teeth, description, cost, standard_cost, discount_amount, pricing_note, date, doctors(name)')
          .gte('date', dateFrom)
          .lte('date', dateTo)
          .order('date', { ascending: false })
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (locationId) query = query.eq('location_id', locationId);

        let { data, error }: { data: any[] | null; error: any } = await query;
        if (error && isOptionalRelationAccessError(error, ['doctors'])) {
          let fallbackQuery = supabase
            .from('treatments')
            .select('id, location_id, patient_id, doctor_id, treatment_type_id, teeth, description, cost, standard_cost, discount_amount, pricing_note, date')
            .gte('date', dateFrom)
            .lte('date', dateTo)
            .order('date', { ascending: false })
            .order('id', { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (locationId) fallbackQuery = fallbackQuery.eq('location_id', locationId);
          const fallback = await fallbackQuery;
          data = fallback.data;
          error = fallback.error;
        }
        if (error) throw new Error(error.message || 'Treatment analysis could not be loaded.');

        const page = data || [];
        records.push(...page.map((record: any) => ({
          ...record,
          standardCost: record.standard_cost ?? null,
          discountAmount: Number(record.discount_amount || 0),
          pricingNote: record.pricing_note || null,
          doctor_name: record.doctors?.name || undefined
        })));

        if (page.length < pageSize) break;
      }

      return records;
    },
    getMonthlyReportRecords: async ({
      locationId,
      dateFrom,
      dateTo,
      onProgress
    }: {
      locationId?: string;
      dateFrom: string;
      dateTo: string;
      onProgress?: (completed: number, total: number) => void;
    }): Promise<{ records: MonthlyReportSourceRecord[]; allocationRecords: MonthlyReportSourceRecord[] }> => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
        throw new Error('A valid monthly report date range is required.');
      }

      const pageSize = 1000;
      const loadPages = async (fromDate?: string, patientIds?: string[]): Promise<MonthlyReportSourceRecord[]> => {
        const records: MonthlyReportSourceRecord[] = [];
        for (let offset = 0; ; offset += pageSize) {
          const buildQuery = (withRelations: boolean, regionColumn: 'township' | 'state_region' = 'township') => {
            let query = supabase
              .from('treatments')
              .select(withRelations
                ? `id, location_id, patient_id, doctor_id, treatment_type_id, teeth, description, cost, standard_cost, discount_amount, pricing_note, doctor_earnings, date, patients(name, age, phone, city, ${regionColumn}, patient_type), doctors(name)`
                : 'id, location_id, patient_id, doctor_id, treatment_type_id, teeth, description, cost, standard_cost, discount_amount, pricing_note, doctor_earnings, date')
              .lte('date', dateTo)
              .order('date', { ascending: true })
              .order('id', { ascending: true })
              .range(offset, offset + pageSize - 1);
            if (fromDate) query = query.gte('date', fromDate);
            if (patientIds?.length) query = query.in('patient_id', patientIds);
            if (locationId) query = query.eq('location_id', locationId);
            return query;
          };

          let { data, error }: { data: any[] | null; error: any } = await buildQuery(true);
          let patientRegionColumn: 'township' | 'state_region' = 'township';
          if (error && isMissingColumnError(error, 'township')) {
            patientRegionColumn = 'state_region';
            const legacyRegionFallback = await buildQuery(true, patientRegionColumn);
            data = legacyRegionFallback.data;
            error = legacyRegionFallback.error;
          }
          if (error && isOptionalRelationAccessError(error, ['patients', 'doctors'])) {
            const fallback = await buildQuery(false);
            data = fallback.data;
            error = fallback.error;
          }
          if (error) throw new Error(error.message || 'Monthly report treatments could not be loaded.');
          const page = data || [];
          records.push(...page.map((record: any) => ({
            ...record,
            standardCost: record.standard_cost ?? null,
            discountAmount: Number(record.discount_amount || 0),
            pricingNote: record.pricing_note || null,
            doctorEarnings: Number(record.doctor_earnings || 0),
            patient_name: record.patients?.name || 'Unknown patient',
            patient_age: record.patients?.age ?? null,
            patient_phone: record.patients?.phone || null,
            patient_city: record.patients?.city || null,
            patient_township: record.patients?.[patientRegionColumn] || null,
            patient_type: record.patients?.patient_type || null,
            doctor_name: record.doctors?.name || undefined
          })));
          if (page.length < pageSize) break;
        }
        return records;
      };

      let records = await loadPages(dateFrom);
      if (records.length === 0) return { records: [], allocationRecords: [] };
      const entriesByTreatment = await getDoctorEarningEntriesByTreatmentIds(records.map(record => record.id));
      records = records.map(record => {
        const entries = entriesByTreatment.get(record.id);
        if (!entries?.length) return record;
        return {
          ...record,
          doctorEarnings: entries
            .filter(entry => entry.paymentDate <= dateTo)
            .reduce((sum, entry) => sum + Number(entry.earnings || 0), 0)
        };
      });
      const patientBatches = chunkMonthlyReportPatientIds(records.map(record => record.patient_id));
      const allocationRecords: MonthlyReportSourceRecord[] = [];
      onProgress?.(1, patientBatches.length + 1);
      // Run bounded requests sequentially to avoid a burst of long PostgREST URLs at the proxy.
      for (let batchIndex = 0; batchIndex < patientBatches.length; batchIndex += 1) {
        const patientBatch = patientBatches[batchIndex];
        allocationRecords.push(...await loadPages(undefined, patientBatch));
        onProgress?.(batchIndex + 2, patientBatches.length + 1);
      }
      return { records, allocationRecords };
    },
    getAllRecords: async (locationId?: string, options?: {
      limit?: number | null;
      dateFrom?: string;
      dateTo?: string;
      doctorId?: string;
      patientId?: string;
      includeCommissionEntries?: boolean;
      throwOnError?: boolean;
    }): Promise<ClinicalRecord[]> => {
      try {
        const limit = options?.limit === undefined ? 50 : options.limit;
        const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : null;
        const records: any[] = [];
        for (let offset = 0; effectiveLimit === null || records.length < effectiveLimit; offset += SUPABASE_PAGE_SIZE) {
          const pageSize = effectiveLimit === null ? SUPABASE_PAGE_SIZE : Math.min(SUPABASE_PAGE_SIZE, effectiveLimit - records.length);
          let query = supabase
            .from('treatments')
            .select('*, patients(name, patient_unique_id, balance, patient_type), doctors(name, specialization, commission_type, commission_percentage, commission_per_visit)')
            .order('date', { ascending: false })
            .order('id')
            .range(offset, offset + pageSize - 1);
          if (locationId) query = query.eq('location_id', locationId);
          if (options?.dateFrom) query = query.gte('date', options.dateFrom);
          if (options?.dateTo) query = query.lte('date', options.dateTo);
          if (options?.doctorId) query = query.eq('doctor_id', options.doctorId);
          if (options?.patientId) query = query.eq('patient_id', options.patientId);
          let { data, error } = await query;

          if (error && isOptionalRelationAccessError(error, ['patients', 'doctors'])) {
            let fallbackQuery = supabase
              .from('treatments')
              .select('*')
              .order('date', { ascending: false })
              .order('id')
              .range(offset, offset + pageSize - 1);
            if (locationId) fallbackQuery = fallbackQuery.eq('location_id', locationId);
            if (options?.dateFrom) fallbackQuery = fallbackQuery.gte('date', options.dateFrom);
            if (options?.dateTo) fallbackQuery = fallbackQuery.lte('date', options.dateTo);
            if (options?.doctorId) fallbackQuery = fallbackQuery.eq('doctor_id', options.doctorId);
            if (options?.patientId) fallbackQuery = fallbackQuery.eq('patient_id', options.patientId);
            const fallback = await fallbackQuery;
            data = fallback.data;
            error = fallback.error;
          }

          if (error) throw error;
          const page = data || [];
          records.push(...page);
          if (page.length < pageSize) break;
        }

        const entriesByTreatment = options?.includeCommissionEntries === false
          ? new Map<string, any[]>()
          : await getDoctorEarningEntriesByTreatmentIds(records.map((rec: any) => rec.id));

        return records.map((rec: any) => ({
          ...rec,
          standardCost: rec.standard_cost ?? null,
          discountAmount: Number(rec.discount_amount || 0),
          pricingNote: rec.pricing_note || null,
          doctorEarnings: Number(rec.doctor_earnings || 0),
          doctorEarningEntries: entriesByTreatment.get(rec.id) || (
            Number(rec.doctor_earnings || 0) > 0 && rec.doctor_id
              ? [{
                  paymentId: `legacy-${rec.id}`,
                  treatmentId: rec.id,
                  doctorId: rec.doctor_id,
                  paymentDate: rec.date,
                  treatmentDate: rec.date,
                    calculationMode: usesFlatVisitCommission({
                      commissionType: rec.commission_type_snapshot ?? rec.doctors?.commission_type,
                      specialization: rec.doctors?.specialization
                    }) ? 'flat_visit' : 'percentage',
                  allocatedPayment: Number(rec.cost || 0),
                    commissionRate: Number((usesFlatVisitCommission({
                      commissionType: rec.commission_type_snapshot ?? rec.doctors?.commission_type,
                      specialization: rec.doctors?.specialization
                    }) ? (rec.commission_per_visit_snapshot ?? rec.doctors?.commission_per_visit) : (rec.commission_percentage_snapshot ?? rec.doctors?.commission_percentage)) || 0),
                  earnings: Number(rec.doctor_earnings || 0)
                }]
              : []
          ),
          patient_name: rec.patients?.name || 'Unknown',
          patient_unique_id: rec.patients?.patient_unique_id || undefined,
          patient_type: rec.patients?.patient_type || null,
          patient_balance: Number(rec.patients?.balance || 0),
          doctor_name: rec.doctors?.name || undefined,
          doctor_specialization: rec.doctors?.specialization || null,
          doctor_commission_type: resolveDoctorCommissionType({
            commissionType: rec.commission_type_snapshot ?? rec.doctors?.commission_type,
            specialization: rec.doctors?.specialization
          }),
          doctor_commission_percentage: rec.commission_percentage_snapshot !== undefined && rec.commission_percentage_snapshot !== null
            ? Number(rec.commission_percentage_snapshot)
            : rec.doctors?.commission_percentage !== undefined ? Number(rec.doctors.commission_percentage || 0) : null,
          doctor_commission_per_visit: rec.commission_per_visit_snapshot !== undefined && rec.commission_per_visit_snapshot !== null
            ? Number(rec.commission_per_visit_snapshot)
            : rec.doctors?.commission_per_visit !== undefined ? Number(rec.doctors.commission_per_visit || 0) : null,
          doctor_commission_source: rec.commission_source_snapshot || null,
          doctor_commission_snapshot_at: rec.commission_snapshot_at || null
        }));
      } catch (err) {
        console.warn("Error fetching records:", err);
        if (options?.throwOnError) throw err;
        return [];
      }
    },
    updateAuditRecord: async (
      id: string,
      data: Partial<Pick<ClinicalRecord, 'date' | 'description' | 'teeth' | 'doctor_id'>>
    ): Promise<ClinicalRecord> => {
      if (data.teeth) {
        const invalidTeeth = findInvalidTeeth(data.teeth);
        if (invalidTeeth.length > 0) {
          throw new Error(`Invalid tooth labels: ${invalidTeeth.join(', ')}. Use adult FDI numbers or baby labels 1A-4E.`);
        }
      }

      const { data: existingRecord, error: existingRecordError } = await supabase
        .from('treatments')
        .select('id, cost, doctor_id, standard_cost')
        .eq('id', id)
        .single();

      if (existingRecordError) throw new Error(existingRecordError.message);

      const nextDoctorId = Object.prototype.hasOwnProperty.call(data, 'doctor_id')
        ? (data.doctor_id && String(data.doctor_id).trim() !== '' ? data.doctor_id : null)
        : existingRecord.doctor_id;

      const payload = {
        date: data.date,
        description: data.description,
        teeth: data.teeth,
        doctor_id: nextDoctorId,
        doctor_earnings: 0
      };

      let { data: result, error } = await supabase
        .from('treatments')
        .update(payload)
        .eq('id', id)
        .select('*')
        .single();

      if (error) throw new Error(error.message);

      await recalculateDoctorEarningsForTreatments([id]);

      const { data: recalculatedRecord, error: recalculatedError } = await supabase
        .from('treatments')
        .select('*')
        .eq('id', id)
        .single();

      if (recalculatedError) throw new Error(recalculatedError.message);
      result = recalculatedRecord || result;

      return {
        ...result,
        standardCost: result.standard_cost ?? existingRecord.standard_cost ?? null,
        discountAmount: Number(result.discount_amount || 0),
        pricingNote: result.pricing_note || null,
        doctorEarnings: Number(result.doctor_earnings || 0),
        patient_name: result.patients?.name || 'Unknown',
        patient_balance: Number(result.patients?.balance || 0),
        doctor_name: result.doctors?.name || undefined
      };
    },
    deleteAllRecords: async (locationId?: string): Promise<void> => {
      let query = supabase
        .from('treatments')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (locationId) {
        query = query.eq('location_id', locationId);
      }

      const { error } = await query;

      if (error) throw new Error(error.message);
    },
    record: async (data: { 
      location_id: string; 
      patient_id: string;
      doctor_id?: string;
      treatment_type_id?: string;
      teeth: number[];
      description: string;
      cost: number;
      standardCost?: number;
      discountAmount?: number;
      pricingNote?: 'FOC' | 'DISCOUNT' | null;
      medications?: { id: string; qty: number }[]
    }) => {
      if (!data.location_id) throw new Error('location_id is required');

      if (data.teeth && data.teeth.length > 0) {
        const invalidTeeth = findInvalidTeeth(data.teeth);
        if (invalidTeeth.length > 0) {
          throw new Error(`Invalid tooth labels: ${invalidTeeth.join(', ')}. Use adult FDI numbers or baby labels 1A-4E.`);
        }
      }

      const treatmentDate = getLocalISODate();
      const { data: rpcResult, error } = await supabase.rpc('record_treatment_atomic', {
        p_location_id: data.location_id,
        p_patient_id: data.patient_id,
        p_doctor_id: data.doctor_id || null,
        p_treatment_type_id: data.treatment_type_id || null,
        p_teeth: data.teeth || [],
        p_description: data.description,
        p_cost: data.cost,
        p_standard_cost: data.standardCost ?? data.cost,
        p_discount_amount: data.discountAmount ?? 0,
        p_pricing_note: data.pricingNote || null,
        p_medications: data.medications || [],
        p_treatment_date: treatmentDate
      });

      if (error) {
        if (isMissingFunctionError(error, 'record_treatment_atomic')) {
          throw new Error('Atomic treatment recording is not installed. Apply the atomic clinical workflows migration before recording treatments.');
        }
        throw new Error(error.message);
      }

      const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
      if (!result?.record) throw new Error('Treatment recording returned no record.');

      return {
        ...result,
        status: 'success',
        completed_appointment_ids: result.completed_appointment_ids || [],
        record: {
          ...result.record,
          standardCost: result.record.standard_cost ?? null,
          doctorEarnings: Number(result.record.doctor_earnings || 0),
          discountAmount: Number(result.record.discount_amount || 0),
          pricingNote: result.record.pricing_note || null,
          doctor_commission_type: result.record.commission_type_snapshot || null,
          doctor_commission_percentage: result.record.commission_percentage_snapshot === null || result.record.commission_percentage_snapshot === undefined ? null : Number(result.record.commission_percentage_snapshot),
          doctor_commission_per_visit: result.record.commission_per_visit_snapshot === null || result.record.commission_per_visit_snapshot === undefined ? null : Number(result.record.commission_per_visit_snapshot),
          doctor_commission_source: result.record.commission_source_snapshot || null,
          doctor_commission_snapshot_at: result.record.commission_snapshot_at || null
        }
      };
    },
    undoRecord: async (recordId: string) => {
      const { data, error } = await supabase.rpc('undo_treatment_atomic', {
        p_treatment_id: recordId
      });
      if (error) {
        if (isMissingFunctionError(error, 'undo_treatment_atomic')) {
          throw new Error('Atomic treatment undo is not installed. Apply the undo treatment migration before undoing treatments.');
        }
        throw new Error(error.message);
      }

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.treatment_id) throw new Error('Treatment undo returned no result.');
      return result;
    }
  },

  doctors: {
    checkDoctorRecords: async (doctorId: string, locationId?: string): Promise<{
      hasAppointments: boolean;
      hasTreatments: boolean;
      hasAny: boolean;
    }> => {
      let appointmentsQuery = supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('doctor_id', doctorId);

      if (locationId) {
        appointmentsQuery = appointmentsQuery.eq('location_id', locationId);
      }

      let treatmentsQuery = supabase
        .from('treatments')
        .select('id', { count: 'exact', head: true })
        .eq('doctor_id', doctorId);

      if (locationId) {
        treatmentsQuery = treatmentsQuery.eq('location_id', locationId);
      }

      const [
        { count: appointmentCount, error: appointmentError },
        { count: treatmentCount, error: treatmentError }
      ] = await Promise.all([
        appointmentsQuery,
        treatmentsQuery
      ]);

      if (appointmentError) throw new Error(appointmentError.message);
      if (treatmentError) throw new Error(treatmentError.message);

      const hasAppointments = (appointmentCount || 0) > 0;
      const hasTreatments = (treatmentCount || 0) > 0;

      return {
        hasAppointments,
        hasTreatments,
        hasAny: hasAppointments || hasTreatments
      };
    },
    getAll: async (locationId?: string): Promise<Doctor[]> => {
      try {
        let supportsDoctorLocations = false;
        try {
          supportsDoctorLocations = await detectDoctorLocationsSupport();
        } catch (supportError) {
          console.warn('Could not check doctor branch assignments. Falling back to primary doctor locations.', supportError);
        }
        let query = supabase
          .from('doctors')
          .select(`*, doctor_schedules(*)${supportsDoctorLocations ? ', doctor_locations(location_id)' : ''}`)
          .order('name');
        
        if (locationId && !supportsDoctorLocations) {
          query = query.eq('location_id', locationId);
        }

        let { data, error } = await query;

        if (error && isOptionalRelationAccessError(error, ['doctor_schedules', 'doctor_locations'])) {
          let fallbackQuery = supabase
            .from('doctors')
            .select('*')
            .order('name');

          if (locationId) {
            fallbackQuery = fallbackQuery.eq('location_id', locationId);
          }

          const fallback = await fallbackQuery;
          data = fallback.data;
          error = fallback.error;
          supportsDoctorLocations = false;
        }
        
        if (error) throw error;
        
        const doctors = (data || []).map(mapDoctor);
        return locationId && supportsDoctorLocations
          ? doctors.filter((doctor) => (doctor.location_ids || [doctor.location_id]).includes(locationId))
          : doctors;
      } catch (err) {
        console.warn("Error fetching doctors:", err);
        return [];
      }
    },
    create: async (data: Partial<Doctor> | any): Promise<Doctor> => {
      const locationIds = getDoctorLocationIds(data);
      const primaryLocationId = locationIds[0] || data.location_id;
      const trimmedPassword = typeof data.password === 'string' ? data.password.trim() : '';
      const trimmedEmail = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
      if (trimmedPassword && !trimmedEmail) {
        throw new Error('Doctor email is required to create a doctor login account.');
      }
      const commissionType = data.commission_type === undefined
        ? resolveDoctorCommissionType({ specialization: data.specialization })
        : validateDoctorCommissionType(data.commission_type);
      const commissionPercentage = validateDoctorCommissionPercentage(data.commission_percentage);
      const commissionPerVisit = validateDoctorCommissionPerVisit(data.commission_per_visit);
      // First create the doctor
      const { data: doctorData, error: doctorError } = await supabase
        .from('doctors')
        .insert(buildDoctorDirectWritePayload({
          location_id: primaryLocationId,
          name: data.name,
          email: trimmedEmail || null,
          phone: data.phone,
          specialization: String(data.specialization || '').trim() || 'General',
          password: trimmedPassword || null
        }))
        .select()
        .single();

      if (doctorError) {
        if (isMissingColumnError(doctorError, 'commission_type')) {
          throw new Error('Doctor commission settings are not installed yet. Run database/configurable_doctor_commission_migration.sql before saving doctors.');
        }
        throw new Error(doctorError.message);
      }

      if (trimmedPassword) {
        try {
          const supportsDoctorId = await detectUsersDoctorIdSupport();
          if (!supportsDoctorId) {
            throw new Error('Database update required: users.doctor_id is missing. Run database/add_doctor_password.sql first.');
          }

          const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
          const { data: existingUsername } = await supabase
            .from('users')
            .select('id')
            .eq('username', trimmedEmail)
            .maybeSingle();

          if (existingUsername) {
            throw new Error('Doctor email is already used by another staff account.');
          }

          const doctorUserPayload: any = {
            location_id: primaryLocationId || null,
            doctor_id: doctorData.id,
            username: trimmedEmail,
            password: trimmedPassword,
            role: 'normal'
          };

          if (supportsAllowedTabs) {
            doctorUserPayload.allowed_tabs = DOCTOR_DASHBOARD_TABS;
          }

          const { error: userCreateError } = await supabase
            .from('users')
            .insert(doctorUserPayload);

          if (userCreateError) {
            throw new Error(userCreateError.message);
          }
        } catch (doctorUserError: any) {
          await supabase.from('doctors').delete().eq('id', doctorData.id);
          throw new Error(doctorUserError.message || 'Failed to create doctor login account.');
        }
      }

      await saveDoctorLocations(doctorData.id, locationIds);

      // Then create schedules if provided (filter and validate)
      if (data.schedules && data.schedules.length > 0) {
        const validSchedules = data.schedules
          .filter((sched: DoctorScheduleInput) => {
            // Filter out schedules with missing data
            if (!sched.start_time || !sched.end_time || sched.day_of_week === undefined) {
              return false;
            }
            // Validate that end_time > start_time
            const start = new Date(`2000-01-01T${sched.start_time}`);
            const end = new Date(`2000-01-01T${sched.end_time}`);
            return end > start;
          })
          .map((sched: DoctorScheduleInput) => ({
            doctor_id: doctorData.id,
            day_of_week: sched.day_of_week,
            start_time: sched.start_time,
            end_time: sched.end_time
          }));

        if (validSchedules.length > 0) {
          const { error: scheduleError } = await supabase
            .from('doctor_schedules')
            .insert(validSchedules);

          if (scheduleError) throw new Error(scheduleError.message);
        }
      }

      // Fetch the complete doctor with schedules when optional relations are available.
      const completeDoctor = await fetchDoctorWithOptionalRelations(doctorData.id);

      return mapDoctor(completeDoctor);
    },
    update: async (id: string, data: Partial<Doctor> | any): Promise<Doctor> => {
      const { data: existingDoctor, error: existingDoctorError } = await supabase
        .from('doctors')
        .select('email, location_id, specialization, commission_type')
        .eq('id', id)
        .single();

      if (existingDoctorError) throw new Error(existingDoctorError.message);

      const hasLocationAssignments = data.location_ids !== undefined || (data.location_id !== undefined && data.location_id !== existingDoctor.location_id);
      const locationIds = hasLocationAssignments ? getDoctorLocationIds(data) : [];
      const primaryLocationId = hasLocationAssignments ? locationIds[0] : data.location_id;

      const trimmedPassword = typeof data.password === 'string' ? data.password.trim() : '';
      const nextEmailRaw = data.email !== undefined ? data.email : existingDoctor.email;
      const nextEmail = typeof nextEmailRaw === 'string' ? nextEmailRaw.trim().toLowerCase() : '';
      const supportsDoctorId = await detectUsersDoctorIdSupport();
      const linkedDoctorUserQuery = supportsDoctorId
        ? await supabase
            .from('users')
            .select('id')
            .eq('doctor_id', id)
            .maybeSingle()
        : { data: null, error: null };

      if (linkedDoctorUserQuery.error) {
        throw new Error(linkedDoctorUserQuery.error.message);
      }

      const linkedDoctorUserBefore = linkedDoctorUserQuery.data;

      if ((linkedDoctorUserBefore || trimmedPassword) && !nextEmail) {
        throw new Error('Doctor email is required for doctor login accounts.');
      }

      if (hasLocationAssignments && existingDoctor?.location_id && !locationIds.includes(existingDoctor.location_id)) {
          const doctorRecordState = await api.doctors.checkDoctorRecords(id, existingDoctor.location_id || undefined);
          if (doctorRecordState.hasAny) {
            throw new Error('Cannot transfer doctor: Doctor has existing appointments or treatment history in this branch.');
          }
      }

      // Update doctor info
      const doctorUpdatePayload = buildDoctorDirectWritePayload({
        location_id: primaryLocationId,
        name: data.name,
        email: nextEmail || null,
        phone: data.phone,
        specialization: data.specialization === undefined
          ? undefined
          : String(data.specialization || '').trim() || 'General',
        password: trimmedPassword || undefined
      });

      const { error: doctorError } = await supabase
        .from('doctors')
        .update(doctorUpdatePayload)
        .eq('id', id);

      if (doctorError) {
        if (isMissingColumnError(doctorError, 'commission_type')) {
          throw new Error('Doctor commission settings are not installed yet. Run database/configurable_doctor_commission_migration.sql before saving doctors.');
        }
        throw new Error(doctorError.message);
      }
      if (hasLocationAssignments) {
        await saveDoctorLocations(id, locationIds);
      }
      if (supportsDoctorId) {
        const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
        const { data: linkedDoctorUser } = await supabase
          .from('users')
          .select('id')
          .eq('doctor_id', id)
          .maybeSingle();

        const shouldManageDoctorLogin = Boolean(linkedDoctorUser) || Boolean(trimmedPassword);

        if (shouldManageDoctorLogin) {
          if (!nextEmail) {
            throw new Error('Doctor email is required for doctor login accounts.');
          }

          const { data: duplicateUsername } = await supabase
            .from('users')
            .select('id')
            .eq('username', nextEmail)
            .neq('doctor_id', id)
            .maybeSingle();

          if (duplicateUsername) {
            throw new Error('Doctor email is already used by another staff account.');
          }

          if (linkedDoctorUser) {
            const linkedUserPayload: any = {
              username: nextEmail,
              location_id: primaryLocationId || existingDoctor.location_id || null
            };
            if (trimmedPassword) {
              linkedUserPayload.password = trimmedPassword;
            }
            if (supportsAllowedTabs) {
              linkedUserPayload.allowed_tabs = DOCTOR_DASHBOARD_TABS;
            }

            const { error: linkedUserError } = await supabase
              .from('users')
              .update(linkedUserPayload)
              .eq('id', linkedDoctorUser.id);

            if (linkedUserError) throw new Error(linkedUserError.message);
          } else if (trimmedPassword) {
            const newDoctorUserPayload: any = {
              location_id: primaryLocationId || existingDoctor.location_id || null,
              doctor_id: id,
              username: nextEmail,
              password: trimmedPassword,
              role: 'normal'
            };
            if (supportsAllowedTabs) {
              newDoctorUserPayload.allowed_tabs = DOCTOR_DASHBOARD_TABS;
            }

            const { error: createDoctorUserError } = await supabase
              .from('users')
              .insert(newDoctorUserPayload);

            if (createDoctorUserError) throw new Error(createDoctorUserError.message);
          }
        }
      }

      // Update schedules if provided
      if (data.schedules !== undefined) {
        // Delete existing schedules
        await supabase
          .from('doctor_schedules')
          .delete()
          .eq('doctor_id', id);

        // Insert new schedules (filter and validate)
        if (data.schedules.length > 0) {
          const validSchedules = data.schedules
            .filter((sched: DoctorScheduleInput) => {
              // Filter out schedules with missing data
              if (!sched.start_time || !sched.end_time || sched.day_of_week === undefined) {
                return false;
              }
              // Validate that end_time > start_time
              const start = new Date(`2000-01-01T${sched.start_time}`);
              const end = new Date(`2000-01-01T${sched.end_time}`);
              return end > start;
            })
            .map((sched: DoctorScheduleInput) => ({
              doctor_id: id,
              day_of_week: sched.day_of_week,
              start_time: sched.start_time,
              end_time: sched.end_time
            }));

          if (validSchedules.length > 0) {
            const { error: scheduleError } = await supabase
              .from('doctor_schedules')
              .insert(validSchedules);

            if (scheduleError) throw new Error(scheduleError.message);
          }
        }
      }

      // Fetch updated doctor with schedules when optional relations are available.
      const updatedDoctor = await fetchDoctorWithOptionalRelations(id);

      return mapDoctor(updatedDoctor);
    },
    delete: async (id: string): Promise<void> => {
      const supportsDoctorId = await detectUsersDoctorIdSupport();
      if (supportsDoctorId) {
        await supabase
          .from('users')
          .delete()
          .eq('doctor_id', id);
      }

      // Delete schedules first (cascade should handle this, but being explicit)
      await supabase
        .from('doctor_schedules')
        .delete()
        .eq('doctor_id', id);

      // Delete doctor
      const { error } = await supabase
        .from('doctors')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
    },
    getAvailableTimes: async (doctorId: string, date: string): Promise<string[]> => {
      // Get doctor's schedules
      let { data: doctor, error: doctorError } = await supabase
        .from('doctors')
        .select('*, doctor_schedules(*)')
        .eq('id', doctorId)
        .single();

      if (doctorError && isOptionalRelationAccessError(doctorError, ['doctor_schedules'])) {
        const [doctorResult, schedulesResult] = await Promise.all([
          supabase
            .from('doctors')
            .select('*')
            .eq('id', doctorId)
            .single(),
          supabase
            .from('doctor_schedules')
            .select('*')
            .eq('doctor_id', doctorId)
        ]);

        if (doctorResult.error) {
          doctor = null;
          doctorError = doctorResult.error;
        } else {
          doctor = { ...doctorResult.data, doctor_schedules: schedulesResult.error ? [] : (schedulesResult.data || []) };
          doctorError = null;
        }
      }

      if (doctorError) throw new Error(doctorError.message);

      // Get day of week (0 = Sunday, 1 = Monday, etc.)
      const appointmentDate = new Date(date);
      const dayOfWeek = appointmentDate.getDay();

      // Find schedules for this day
      const daySchedules = (doctor.doctor_schedules || []).filter(
        (sched: any) => sched.day_of_week === dayOfWeek
      );

      if (daySchedules.length === 0) return [];

      // Get existing appointments for this doctor on this date
      const { data: existingAppointments } = await supabase
        .from('appointments')
        .select('time')
        .eq('doctor_id', doctorId)
        .eq('date', date)
        .eq('status', 'Scheduled');

      const bookedTimes = new Set((existingAppointments || []).map((apt: any) => apt.time));

      // Generate available time slots (30-minute intervals)
      const availableTimes: string[] = [];
      
      daySchedules.forEach((schedule: any) => {
        const start = new Date(`2000-01-01T${schedule.start_time}`);
        const end = new Date(`2000-01-01T${schedule.end_time}`);
        
        let current = new Date(start);
        while (current < end) {
          const timeStr = current.toTimeString().slice(0, 5); // HH:MM format
          if (!bookedTimes.has(timeStr)) {
            availableTimes.push(timeStr);
          }
          current.setMinutes(current.getMinutes() + 30);
        }
      });

      return availableTimes.sort();
    }
  },

  doctorTreatmentCommissions: {
    getByDoctor: async (doctorId: string): Promise<DoctorTreatmentCommission[]> => {
      const { data, error } = await supabase
        .from('doctor_treatment_commissions')
        .select(`
          id,
          doctor_id,
          treatment_id,
          commission_rate,
          fixed_amount,
          created_at,
          updated_at,
          treatment_types:treatment_id (
            name
          )
        `)
        .eq('doctor_id', doctorId)
        .order('created_at', { ascending: true });

      if (error) throw new Error(error.message);

      return (data || []).map((row: any) => ({
        id: row.id,
        doctor_id: row.doctor_id,
        treatment_id: row.treatment_id,
        commission_rate: Number(row.commission_rate ?? 0),
        fixed_amount: row.fixed_amount === null || row.fixed_amount === undefined ? null : Number(row.fixed_amount),
        created_at: row.created_at,
        updated_at: row.updated_at,
        treatment_name: row.treatment_types?.name || undefined
      }));
    },
    replaceForDoctor: async (
      doctorId: string,
      commissionType: 'percentage' | 'fixed',
      commissionPercentage: number,
      commissionPerVisit: number,
      commissions: DoctorTreatmentCommission[],
      actor: { userId: string; authToken: string }
    ): Promise<void> => {
      const normalized = commissions
        .filter((entry) => entry.treatment_id)
        .map((entry) => ({
          treatment_id: entry.treatment_id,
          commission_rate: commissionType === 'percentage' ? Number(entry.commission_rate ?? 0) : 0,
          fixed_amount: commissionType === 'fixed' ? Number(entry.fixed_amount ?? 0) : null
        }));

      const { error } = await supabase.rpc('configure_doctor_commission', {
        p_doctor_id: doctorId,
        p_commission_type: commissionType,
        p_commission_percentage: commissionPercentage,
        p_commission_per_visit: commissionPerVisit,
        p_commissions: normalized,
        p_user_id: actor.userId,
        p_session_token: actor.authToken
      });
      if (error) {
        if (isMissingRpcError(error, 'configure_doctor_commission')) {
          throw new Error('Transactional doctor commission saving is not installed. Run database/configurable_doctor_commission_migration.sql before saving custom rates.');
        }
        throw new Error(error.message);
      }
      if (commissionType === 'percentage') {
        await refreshDoctorDefaultPercentageSnapshots(doctorId, commissionPercentage);
      }
    },
    getApplicableRate: async (doctorId: string, treatmentId: string): Promise<number> => {
      const { data, error } = await supabase.rpc('get_applicable_commission_rate', {
        p_doctor_id: doctorId,
        p_treatment_id: treatmentId
      });

      if (error) throw new Error(error.message);

      return Number(data ?? 0);
    }
  },

  finance: {
    supportsSplitPayments: async (): Promise<boolean> => {
      const { error } = await supabase
        .from('payment_allocations')
        .select('id')
        .limit(1);
      return !error;
    },
    getMonthlyReportPayments: async ({ locationId, dateTo, patientIds, onProgress }: { locationId?: string; dateTo: string; patientIds: string[]; onProgress?: (completed: number, total: number) => void }): Promise<PaymentRecord[]> => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) throw new Error('A valid monthly report end date is required.');
      const patientBatches = chunkMonthlyReportPatientIds(patientIds);
      if (patientBatches.length === 0) return [];
      const pageSize = 1000;
      const payments: PaymentRecord[] = [];
      for (let batchIndex = 0; batchIndex < patientBatches.length; batchIndex += 1) {
        const patientBatch = patientBatches[batchIndex];
        for (let offset = 0; ; offset += pageSize) {
        const buildQuery = (withRelations: boolean) => {
          let query = supabase
            .from('payments')
            .select(withRelations
              ? '*, patients(name, balance, patient_type), voided_by_user:users!payments_voided_by_fkey(username), payment_allocations(id, payment_id, payment_method, amount, reference), payment_corrections(id, payment_id, old_amount, new_amount, old_method, new_method, old_allocations, new_allocations, reason, edited_by, edited_at, editor:users!payment_corrections_edited_by_fkey(username))'
              : '*')
            .lte('payment_date', dateTo)
            .order('payment_date', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (locationId) query = query.eq('location_id', locationId);
          query = query.in('patient_id', patientBatch);
          return query;
        };

        let { data, error }: { data: any[] | null; error: any } = await buildQuery(true);
        if (error && isOptionalRelationAccessError(error, ['patients', 'payment_allocations', 'payment_corrections', 'users'])) {
          const fallback = await buildQuery(false);
          data = fallback.data;
          error = fallback.error;
        }
        if (error) {
          if (isMissingRelationError(error, 'payments')) {
            throw new Error('Monthly Report payment data is unavailable because payment storage is not installed.');
          }
          throw new Error(error.message || 'Monthly report payments could not be loaded.');
        }
        const page = data || [];
        payments.push(...page.map(mapPaymentRow));
        if (page.length < pageSize) break;
        }
        onProgress?.(batchIndex + 1, patientBatches.length);
      }
      return payments;
    },
    getPayments: async (locationId?: string, options?: {
      dateFrom?: string;
      dateTo?: string;
      patientId?: string;
    }): Promise<PaymentRecord[]> => {
      const buildPaymentQuery = (columns: string) => (from: number, to: number) => {
        let query = supabase
          .from('payments')
          .select(columns)
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to);
        if (locationId) query = query.eq('location_id', locationId);
        if (options?.dateFrom) query = query.gte('payment_date', options.dateFrom);
        if (options?.dateTo) query = query.lte('payment_date', options.dateTo);
        if (options?.patientId) query = query.eq('patient_id', options.patientId);
        return query;
      };

      const fullColumns = `
          *,
          patients(name, balance, patient_type),
          voided_by_user:users!payments_voided_by_fkey(username),
          payment_allocations (id, payment_id, payment_method, amount, reference),
          payment_corrections (
            id,
            payment_id,
            old_amount,
            new_amount,
            old_method,
            new_method,
            old_allocations,
            new_allocations,
            reason,
            edited_by,
            edited_at,
            editor:users!payment_corrections_edited_by_fkey (
              username
            )
          )
        `;

      let { data, error } = await fetchAllRows<any>(buildPaymentQuery(fullColumns));
      if (error && isOptionalRelationAccessError(error, ['payment_allocations'])) {
        const fallback = await fetchAllRows<any>(buildPaymentQuery(
          '*, patients(name, balance, patient_type), payment_corrections(*, editor:users!payment_corrections_edited_by_fkey(username))'
        ));
        data = fallback.data;
        error = fallback.error;
      }
      if (error && isMissingRelationError(error, 'payment_corrections')) {
        const fallback = await fetchAllRows<any>(buildPaymentQuery('*, patients(name, balance, patient_type)'));
        data = fallback.data;
        error = fallback.error;
      }

      if (error && isOptionalRelationAccessError(error, ['patients', 'payment_allocations', 'payment_corrections', 'users'])) {
        const fallback = await fetchAllRows<any>(buildPaymentQuery('*'));
        data = fallback.data;
        error = fallback.error;
      }

      if (error) {
        if (isMissingRelationError(error, 'payments')) {
          console.warn('Payment storage is not installed yet. Payment history will remain unavailable until the migration is applied.');
          return [];
        }
        throw new Error(error.message);
      }

      return (data || []).map(mapPaymentRow);
    },
    processPayment: async (input: {
      patientId: string;
      amount: number;
      paymentMethod: PaymentMethod;
      allocations?: PaymentAllocation[];
      treatmentIds?: string[];
      paymentDate?: string;
      submissionKey?: string | null;
      receiptSnapshot?: PaymentReceiptSnapshot | Record<string, unknown> | null;
      createdByUserId?: string | null;
      createdByUserName?: string | null;
    }) => {
      const normalizedAmount = Number(input.amount || 0);
      if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('Payment amount must be greater than 0.');
      }
      if (normalizePaymentMethod(input.paymentMethod) === 'UNKNOWN') {
        throw new Error('Select a valid payment method.');
      }
      const allocations = normalizePaymentAllocations(input.allocations, input.paymentMethod, normalizedAmount);
      const allocationError = validatePaymentAllocations(allocations, normalizedAmount);
      if (allocationError) throw new Error(allocationError);

      if (allocations.length > 1) {
        const { data, error } = await supabase.rpc('process_patient_split_payment', {
          p_patient_id: input.patientId,
          p_amount: normalizedAmount,
          p_allocations: allocations.map(({ method, amount, reference }) => ({ method, amount, reference: reference || null })),
          p_treatment_ids: input.treatmentIds || [],
          p_payment_date: input.paymentDate || new Date().toISOString().slice(0, 10),
          p_receipt_snapshot: input.receiptSnapshot || null,
          p_submission_key: input.submissionKey?.trim() || null,
          p_created_by_user_id: input.createdByUserId || null,
          p_created_by_user_name: input.createdByUserName || null
        });
        if (error) {
          if (isMissingFunctionError(error, 'process_patient_split_payment')) {
            throw new Error('Split payment storage is not installed. Run database/split_payment_allocations_migration.sql in Supabase before collecting a split payment.');
          }
          throw new Error(error.message);
        }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw new Error('Payment was not recorded.');
        const payment = mapPaymentRow({ ...row, payment_allocations: allocations });
        await recalculateDoctorEarningsForTreatments(await resolvePaymentCommissionTreatmentIds(payment));
        return {
          status: 'success',
          new_balance: payment.remainingBalance,
          amount_collected: payment.amount,
          cleared_amount: payment.clearedAmount ?? payment.amount,
          payment
        };
      }

      const rpcPayload = {
        p_patient_id: input.patientId,
        p_amount: normalizedAmount,
        p_payment_method: input.paymentMethod,
        p_treatment_ids: input.treatmentIds || [],
        p_payment_date: input.paymentDate || new Date().toISOString().slice(0, 10),
        p_receipt_snapshot: input.receiptSnapshot || null,
        p_created_by_user_id: input.createdByUserId || null,
        p_created_by_user_name: input.createdByUserName || null
      };

      const submissionKey = input.submissionKey?.trim() || null;
      const { data, error } = await supabase.rpc('process_patient_payment', submissionKey
        ? { ...rpcPayload, p_submission_key: submissionKey }
        : rpcPayload);

      if (error && submissionKey && isMissingFunctionError(error, 'process_patient_payment')) {
        throw new Error('Idempotent payment storage is not installed. Apply the payment submission idempotency migration before collecting payments.');
      }

      if (error) {
        if (isMissingFunctionError(error, 'process_patient_payment')) {
          throw new Error('Payment receipt storage is not installed. Run database/payment_receipt_snapshot_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('Payment was not recorded.');

      const payment: PaymentRecord = mapPaymentRow(row);
      await recalculateDoctorEarningsForTreatments(await resolvePaymentCommissionTreatmentIds(payment));

      return {
        status: 'success',
        new_balance: payment.remainingBalance,
        amount_collected: payment.amount,
        cleared_amount: payment.clearedAmount ?? payment.amount,
        payment
      };
    },
    saveReceiptSnapshot: async (paymentId: string, snapshot: PaymentReceiptSnapshot): Promise<PaymentReceiptSnapshot> => {
      const { data, error } = await supabase
        .from('payments')
        .update({ receipt_snapshot: snapshot })
        .eq('id', paymentId)
        .select('receipt_snapshot')
        .single();

      if (error) {
        if (isMissingColumnError(error, 'receipt_snapshot')) {
          throw new Error('Payment receipt storage is not installed. Run database/payment_receipt_snapshot_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }

      return normalizePaymentReceiptSnapshot(data?.receipt_snapshot) || snapshot;
    },
    updateAuditEntry: async (
      id: string,
      data: {
        date?: string;
        paymentMethod?: PaymentMethod;
        receiptNumber?: string | null;
      }
    ): Promise<PaymentRecord> => {
      void id;
      void data;
      throw new Error('Direct payment audit edits are disabled. Use the admin payment correction flow so balance changes and correction history stay consistent.');
    },
    correctPayment: async (
      input: {
        paymentId: string;
        newAmount: number;
        newMethod: PaymentMethod;
        allocations?: PaymentAllocation[];
        wasSplitPayment?: boolean;
        reason: string;
        editedByUserId: string;
      }
    ): Promise<PaymentRecord> => {
      const normalizedAmount = Number(input.newAmount || 0);
      const normalizedMethod = normalizePaymentMethod(input.newMethod);
      const normalizedReason = input.reason?.trim() || '';
      const allocations = normalizePaymentAllocations(input.allocations, normalizedMethod, normalizedAmount);
      const allocationError = validatePaymentAllocations(allocations, normalizedAmount);

      if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('Amount must be greater than 0.');
      }
      if (normalizedMethod === 'UNKNOWN') {
        throw new Error('Select a valid payment method.');
      }
      if (allocationError) throw new Error(allocationError);
      if (normalizedReason.length < 10) {
        throw new Error('Correction reason must be at least 10 characters.');
      }
      if (!input.editedByUserId || !String(input.editedByUserId).trim()) {
        throw new Error('Missing admin session. Please log in again.');
      }

      const isSplit = allocations.length > 1 || input.wasSplitPayment === true;
      const { data: correctedPaymentId, error: rpcError } = await supabase.rpc(
        isSplit ? 'correct_split_payment_record' : 'correct_payment_record',
        isSplit ? {
          p_payment_id: input.paymentId,
          p_new_amount: normalizedAmount,
          p_new_allocations: allocations.map(({ method, amount, reference }) => ({ method, amount, reference: reference || null })),
          p_reason: normalizedReason,
          p_edited_by_user_id: input.editedByUserId
        } : {
          p_payment_id: input.paymentId,
          p_new_amount: normalizedAmount,
          p_new_method: normalizedMethod,
          p_reason: normalizedReason,
          p_edited_by_user_id: input.editedByUserId
        }
      );

      if (rpcError) {
        if (isMissingFunctionError(rpcError, isSplit ? 'correct_split_payment_record' : 'correct_payment_record')) {
          throw new Error(isSplit
            ? 'Split payment correction is not installed. Run database/split_payment_allocations_migration.sql in Supabase.'
            : 'Payment correction flow is not installed. Run database/payment_corrections_migration.sql in Supabase.');
        }
        throw new Error(rpcError.message);
      }

      const { data: row, error } = await supabase
        .from('payments')
        .select(`
          *,
          patients(name, balance),
          payment_allocations (id, payment_id, payment_method, amount, reference),
          payment_corrections (
            id,
            payment_id,
            old_amount,
            new_amount,
            old_method,
            new_method,
            old_allocations,
            new_allocations,
            reason,
            edited_by,
            edited_at,
            editor:users!payment_corrections_edited_by_fkey (
              username
            )
          )
        `)
        .eq('id', correctedPaymentId)
        .single();

      if (error) {
        if (isOptionalRelationAccessError(error, ['patients', 'payment_corrections', 'users'])) {
          const fallback = await supabase
            .from('payments')
            .select('*')
            .eq('id', correctedPaymentId)
            .single();
          if (fallback.error) throw new Error(fallback.error.message);
          const correctedPayment = mapPaymentRow(fallback.data);
          await recalculateDoctorEarningsForTreatments(await resolvePaymentCommissionTreatmentIds(correctedPayment));
          return correctedPayment;
        }
        throw new Error(error.message);
      }

      const correctedPayment = mapPaymentRow(row);
      await recalculateDoctorEarningsForTreatments(await resolvePaymentCommissionTreatmentIds(correctedPayment));
      return correctedPayment;
    },
    voidPayment: async (input: {
      paymentId: string;
      reason: string;
      voidedByUserId: string;
    }): Promise<PaymentRecord> => {
      const reason = input.reason?.trim() || '';
      if (!input.paymentId?.trim()) throw new Error('Payment is required.');
      if (reason.length < 10) throw new Error('Void reason must be at least 10 characters.');
      if (reason.length > 500) throw new Error('Void reason cannot exceed 500 characters.');
      if (!input.voidedByUserId?.trim()) throw new Error('Missing admin session. Please log in again.');

      const { data: voidedPaymentId, error: rpcError } = await supabase.rpc('void_payment_record', {
        p_payment_id: input.paymentId,
        p_reason: reason,
        p_voided_by_user_id: input.voidedByUserId
      });

      if (rpcError) {
        if (isMissingFunctionError(rpcError, 'void_payment_record')) {
          throw new Error('Payment void flow is not installed. Run database/payment_void_migration.sql in Supabase.');
        }
        throw new Error(rpcError.message);
      }

      const { data: row, error } = await supabase
        .from('payments')
        .select(`
          *,
          patients(name, balance, patient_type),
          voided_by_user:users!payments_voided_by_fkey(username),
          payment_allocations (id, payment_id, payment_method, amount, reference),
          payment_corrections (*, editor:users!payment_corrections_edited_by_fkey(username))
        `)
        .eq('id', voidedPaymentId)
        .single();

      if (error) {
        const fallback = await supabase.from('payments').select('*, patients(name, balance, patient_type)').eq('id', voidedPaymentId).single();
        if (fallback.error) throw new Error(fallback.error.message);
        const payment = mapPaymentRow(fallback.data);
        await recalculateDoctorEarningsForTreatments(await resolvePaymentCommissionTreatmentIds(payment));
        return payment;
      }

      const payment = mapPaymentRow(row);
      await recalculateDoctorEarningsForTreatments(await resolvePaymentCommissionTreatmentIds(payment));
      return payment;
    }
  },

  appSettings: {
    getS3Settings: async (): Promise<S3Settings> => {
      try {
        const settings = await fetchS3Settings();
        return settings ?? { url: '', accessKey: '', secretKey: '', region: '' };
      } catch (error: any) {
        console.warn('Failed to load S3 settings:', error?.message || error);
        return { url: '', accessKey: '', secretKey: '', region: '' };
      }
    },
    saveS3Settings: async (settings: S3Settings): Promise<void> => {
      const payload = {
        id: APP_SETTINGS_SINGLETON_ID,
        s3_url: settings.url?.trim() || null,
        s3_access_key: settings.accessKey?.trim() || null,
        s3_secret_key: settings.secretKey?.trim() || null,
        s3_region: settings.region?.trim() || null,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('app_settings')
        .upsert(payload);

      if (error) {
        throw new Error(error.message);
      }

      cachedS3Settings = normalizeS3SettingsRow({
        s3_url: payload.s3_url,
        s3_access_key: payload.s3_access_key,
        s3_secret_key: payload.s3_secret_key,
        s3_region: payload.s3_region,
        updated_at: payload.updated_at
      });
      storageConfigVersion += 1;
    },
    getSupabaseStorage: async (): Promise<import('../types').SupabaseStorageSettings> => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('storage_url, storage_anon_key, storage_service_key, storage_bucket, updated_at')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (error || !data) {
          return { storageUrl: '', anonKey: '', serviceKey: '', bucket: '' };
        }

        return {
          storageUrl: data.storage_url || '',
          anonKey: data.storage_anon_key || '',
          serviceKey: data.storage_service_key || '',
          bucket: data.storage_bucket || '',
          updated_at: data.updated_at
        };
      } catch (error: any) {
        console.warn('Failed to load Supabase Storage settings:', error?.message || error);
        return { storageUrl: '', anonKey: '', serviceKey: '', bucket: '' };
      }
    },
    saveSupabaseStorage: async (settings: import('../types').SupabaseStorageSettings): Promise<void> => {
      const payload = {
        id: APP_SETTINGS_SINGLETON_ID,
        storage_url: settings.storageUrl?.trim() || null,
        storage_anon_key: settings.anonKey?.trim() || null,
        storage_service_key: settings.serviceKey?.trim() || null,
        storage_bucket: settings.bucket?.trim() || null,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('app_settings')
        .upsert(payload);

      if (error) {
        throw new Error(error.message);
      }

      storageConfigVersion += 1;
    },
    getEmailSettings: async (): Promise<EmailSettings> => {
      return loadEmailSettingsAsync();
    },
    saveEmailSettings: async (settings: EmailSettings): Promise<EmailSettings> => {
      return saveEmailSettingsAsync(settings);
    },
    getAutoOnpPatientTypeEnabled: async (): Promise<boolean> => {
      return getAutoOnpPatientTypeEnabled();
    },
    saveAutoOnpPatientTypeEnabled: async (enabled: boolean): Promise<void> => {
      const { error } = await supabase
        .from('app_settings')
        .upsert({
          id: APP_SETTINGS_SINGLETON_ID,
          auto_onp_patient_type_enabled: enabled,
          updated_at: new Date().toISOString()
        });

      if (error) {
        if (isMissingColumnError(error, 'auto_onp_patient_type_enabled')) {
          throw new Error('Auto ONP patient type setting is not installed. Run database/auto_onp_patient_type_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }
    },
    getClinicalFeeSettings: async (): Promise<ClinicalFeeSettings> => {
      try {
        let { data, error }: { data: any; error: any } = await supabase
          .from('app_settings')
          .select('clinical_fee_enabled, clinical_fee_amount, clinical_fee_new_patient_amount, clinical_fee_returning_patient_amount')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (
          error &&
          (
            isMissingColumnError(error, 'clinical_fee_new_patient_amount') ||
            isMissingColumnError(error, 'clinical_fee_returning_patient_amount')
          )
        ) {
          const fallbackResult = await supabase
            .from('app_settings')
            .select('clinical_fee_enabled, clinical_fee_amount')
            .eq('id', APP_SETTINGS_SINGLETON_ID)
            .maybeSingle();
          data = fallbackResult.data;
          error = fallbackResult.error;
        }

        if (error || !data) {
          return { enabled: false, newPatientAmount: 0, returningPatientAmount: 0 };
        }

        const legacyAmount = Math.max(0, Number(data.clinical_fee_amount || 0));
        return {
          enabled: Boolean(data.clinical_fee_enabled),
          newPatientAmount: Math.max(0, Number(data.clinical_fee_new_patient_amount ?? legacyAmount)),
          returningPatientAmount: Math.max(0, Number(data.clinical_fee_returning_patient_amount ?? legacyAmount))
        };
      } catch (error: any) {
        console.warn('Failed to load clinical fee settings:', error?.message || error);
        return { enabled: false, newPatientAmount: 0, returningPatientAmount: 0 };
      }
    },
    saveClinicalFeeSettings: async (settings: ClinicalFeeSettings): Promise<void> => {
      const payload = {
        id: APP_SETTINGS_SINGLETON_ID,
        clinical_fee_enabled: settings.enabled,
        clinical_fee_amount: Number(settings.newPatientAmount ?? 0),
        clinical_fee_new_patient_amount: Number(settings.newPatientAmount ?? 0),
        clinical_fee_returning_patient_amount: Number(settings.returningPatientAmount ?? 0),
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('app_settings')
        .upsert(payload);

      if (error) {
        if (
          isMissingColumnError(error, 'clinical_fee_new_patient_amount') ||
          isMissingColumnError(error, 'clinical_fee_returning_patient_amount')
        ) {
          throw new Error('Per-visit clinical fee settings are not installed. Run database/clinical_fee_per_visit_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }
    },

    getAppName: async (): Promise<string> => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('app_name')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (error || !data?.app_name) {
          return 'DentalCloud Pro';
        }

        return data.app_name;
      } catch (error: any) {
        console.warn('Failed to load app name:', error?.message || error);
        return 'DentalCloud Pro';
      }
    },

    saveAppName: async (name: string): Promise<void> => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        throw new Error('Application name is required.');
      }

      const { error } = await supabase
        .from('app_settings')
        .upsert({
          id: APP_SETTINGS_SINGLETON_ID,
          app_name: normalizedName,
          updated_at: new Date().toISOString()
        });

      if (error) {
        throw new Error(error.message);
      }
    },

    getAppLogo: async (): Promise<{ url: string; path: string } | null> => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('app_logo_url, app_logo_path')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (error || !data?.app_logo_url) {
          return null;
        }

        return {
          url: data.app_logo_url,
          path: data.app_logo_path || ''
        };
      } catch (error: any) {
        console.warn('Failed to load app logo:', error?.message || error);
        return null;
      }
    },

    uploadAppLogo: async (file: File): Promise<{ url: string; path: string }> => {
      const fileName = file.name || '';
      const isPng = file.type === 'image/png' && fileName.toLowerCase().endsWith('.png');
      if (!isPng) {
        throw new Error('Only PNG logo files are allowed.');
      }

      const currentLogo = await api.appSettings.getAppLogo();
      const path = `logos/app-logo-${Date.now()}.png`;

      const { error: uploadError } = await supabase.storage
        .from(APP_LOGOS_BUCKET)
        .upload(path, file, {
          cacheControl: '3600',
          contentType: 'image/png',
          upsert: false
        });

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      const { data: publicData } = supabase.storage.from(APP_LOGOS_BUCKET).getPublicUrl(path);
      const publicUrl = publicData.publicUrl;

      const { error: settingsError } = await supabase
        .from('app_settings')
        .upsert({
          id: APP_SETTINGS_SINGLETON_ID,
          app_logo_url: publicUrl,
          app_logo_path: path,
          updated_at: new Date().toISOString()
        });

      if (settingsError) {
        await supabase.storage.from(APP_LOGOS_BUCKET).remove([path]);
        throw new Error(settingsError.message);
      }

      if (currentLogo?.path && currentLogo.path !== path) {
        supabase.storage.from(APP_LOGOS_BUCKET).remove([currentLogo.path]).catch((error) => {
          console.warn('Failed to remove previous app logo:', error);
        });
      }

      return { url: publicUrl, path };
    },

    deleteAppLogo: async (): Promise<void> => {
      const currentLogo = await api.appSettings.getAppLogo();

      const { error: settingsError } = await supabase
        .from('app_settings')
        .upsert({
          id: APP_SETTINGS_SINGLETON_ID,
          app_logo_url: null,
          app_logo_path: null,
          updated_at: new Date().toISOString()
        });

      if (settingsError) {
        throw new Error(settingsError.message);
      }

      if (currentLogo?.path) {
        const { error: removeError } = await supabase.storage
          .from(APP_LOGOS_BUCKET)
          .remove([currentLogo.path]);

        if (removeError) {
          console.warn('Failed to remove app logo file:', removeError.message);
        }
      }
    },

    getReceiptInfo: async (): Promise<{ email: string; phone: string }> => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('receipt_email, receipt_phone')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (error || !data) {
          return { email: 'info@dentflowpro.com', phone: '(555) 123-4567' };
        }

        return {
          email: data.receipt_email || 'info@dentflowpro.com',
          phone: data.receipt_phone || '(555) 123-4567'
        };
      } catch (error: any) {
        console.warn('Failed to load receipt info:', error?.message || error);
        return { email: 'info@dentflowpro.com', phone: '(555) 123-4567' };
      }
    },

    saveReceiptInfo: async (info: { email: string; phone: string }): Promise<void> => {
      const payload = {
        id: APP_SETTINGS_SINGLETON_ID,
        receipt_email: info.email?.trim() || null,
        receipt_phone: info.phone?.trim() || null,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('app_settings')
        .upsert(payload);

      if (error) {
        throw new Error(error.message);
      }
    },

    getReceiptPreferences: async (): Promise<ReceiptPreferences | null> => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('receipt_header_title, currency_unit, receipt_size')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (error) {
          if (
            isMissingColumnError(error, 'receipt_header_title') ||
            isMissingColumnError(error, 'currency_unit') ||
            isMissingColumnError(error, 'receipt_size')
          ) {
            console.warn('Shared receipt preferences are not installed yet.');
            return null;
          }
          throw error;
        }

        if (!data) return DEFAULT_RECEIPT_PREFERENCES;
        return normalizeReceiptPreferences(data);
      } catch (error: any) {
        console.warn('Failed to load shared receipt preferences:', error?.message || error);
        return null;
      }
    },

    saveReceiptPreferences: async (preferences: Partial<ReceiptPreferences>): Promise<void> => {
      const payload: Record<string, unknown> = {
        id: APP_SETTINGS_SINGLETON_ID,
        updated_at: new Date().toISOString()
      };

      if (preferences.headerTitle !== undefined) {
        payload.receipt_header_title = preferences.headerTitle.trim() || null;
      }
      if (preferences.currency !== undefined) {
        if (preferences.currency !== 'USD' && preferences.currency !== 'MMK') {
          throw new Error('Invalid currency unit.');
        }
        payload.currency_unit = preferences.currency;
      }
      if (preferences.receiptSize !== undefined) {
        if (!['A4', 'THERMAL_55MM', 'THERMAL_80MM'].includes(preferences.receiptSize)) {
          throw new Error('Invalid receipt format.');
        }
        payload.receipt_size = preferences.receiptSize;
      }

      const { error } = await supabase
        .from('app_settings')
        .upsert(payload);

      if (error) {
        if (
          isMissingColumnError(error, 'receipt_header_title') ||
          isMissingColumnError(error, 'currency_unit') ||
          isMissingColumnError(error, 'receipt_size')
        ) {
          throw new Error('Shared receipt settings are not installed. Run database/shared_receipt_preferences_migration.sql in Supabase.');
        }
        throw new Error(error.message);
      }
    },

    getHoverTheme: async (): Promise<'blue' | 'green' | 'yellow' | 'brown' | 'dark' | null> => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('hover_theme')
          .eq('id', APP_SETTINGS_SINGLETON_ID)
          .maybeSingle();

        if (error || !data?.hover_theme) {
          return null;
        }

        const theme = String(data.hover_theme).toLowerCase();
        if (theme === 'blue' || theme === 'green' || theme === 'yellow' || theme === 'brown' || theme === 'dark') {
          return theme;
        }

        return null;
      } catch (error: any) {
        console.warn('Failed to load hover theme:', error?.message || error);
        return null;
      }
    },

    saveHoverTheme: async (theme: 'blue' | 'green' | 'yellow' | 'brown' | 'dark'): Promise<void> => {
      const payload = {
        id: APP_SETTINGS_SINGLETON_ID,
        hover_theme: theme,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase
        .from('app_settings')
        .upsert(payload);

      if (error) {
        throw new Error(error.message);
      }
    }
  },

  files: {
    list: async (patientId: string): Promise<PatientFile[]> => {
      console.log('[Files] Listing files for patient:', patientId);
      
      // Check Supabase Storage first
      const supabaseStorage = await resolveActiveSupabaseStorage();
      if (supabaseStorage) {
        console.log('[Files] Using Supabase Storage:', supabaseStorage.bucket);
        const prefix = `${patientId}/`;
        const objects = await listSupabaseStorageFiles(supabaseStorage, prefix);
        console.log('[Files] Raw objects from storage:', objects);
        
        const filtered = objects.filter(item => item.key.startsWith(prefix));
        console.log('[Files] Filtered objects:', filtered);
        
        return filtered
          .sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''))
          .map((item) => {
            const name = item.key.split('/').pop() || item.key;
            return {
              path: item.key,
              name,
              size: item.size || 0,
              type: '',
              uploaded_at: item.lastModified,
              url: buildSupabasePublicUrl(supabaseStorage.storageUrl, supabaseStorage.bucket, item.key)
            };
          });
      }

      // Check S3 settings second
      const s3Settings = await resolveActiveS3Settings();
      if (s3Settings) {
        const prefix = `${patientId}/`;
        const objects = await listS3Objects(s3Settings, prefix);
        const baseUrl = normalizeS3BaseUrl(s3Settings.url);
        return objects
          .filter(item => item.key.startsWith(prefix))
          .sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''))
          .map((item) => {
            const name = item.key.split('/').pop() || item.key;
            const url = isSupabaseS3Endpoint(baseUrl)
              ? buildSupabaseS3PublicUrl(baseUrl, item.key)
              : buildS3FileUrl(baseUrl, item.key);
            return {
              path: item.key,
              name,
              size: item.size || 0,
              type: '',
              uploaded_at: item.lastModified,
              url
            };
          });
      }

      const { data, error } = await supabase.storage
        .from(PATIENT_FILES_BUCKET)
        .list(patientId, { limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } });

      if (error) throw new Error(error.message);

      return (data || []).map((file) => {
        const path = `${patientId}/${file.name}`;
        const { data: publicData } = supabase.storage.from(PATIENT_FILES_BUCKET).getPublicUrl(path);
        return {
          path,
          name: file.name,
          size: file.metadata?.size ?? 0,
          type: file.metadata?.mimetype ?? '',
          uploaded_at: file.created_at,
          url: publicData?.publicUrl || ''
        };
      });
    },
    upload: async (patientId: string, file: File): Promise<PatientFile> => {
      const path = `${patientId}/${Date.now()}-${file.name}`;
      const startVersion = storageConfigVersion;

      // Check Supabase Storage first
      const supabaseStorage = await resolveActiveSupabaseStorage();
      if (supabaseStorage) {
        await uploadSupabaseStorageFile(
          supabaseStorage,
          path,
          file,
          undefined,
          undefined,
          () => storageConfigVersion !== startVersion
        );
        return {
          path,
          name: file.name,
          size: file.size,
          type: file.type,
          uploaded_at: new Date().toISOString(),
          url: buildSupabasePublicUrl(supabaseStorage.storageUrl, supabaseStorage.bucket, path)
        };
      }

      // Check S3 settings second
      const s3Settings = await resolveActiveS3Settings();
      if (s3Settings) {
        await uploadS3Object(
          s3Settings,
          path,
          file,
          undefined,
          undefined,
          () => storageConfigVersion !== startVersion
        );
        const baseUrl = normalizeS3BaseUrl(s3Settings.url);
        const url = isSupabaseS3Endpoint(baseUrl)
          ? buildSupabaseS3PublicUrl(baseUrl, path)
          : buildS3FileUrl(baseUrl, path);
        return {
          path,
          name: file.name,
          size: file.size,
          type: file.type,
          uploaded_at: new Date().toISOString(),
          url
        };
      }

      const { error: uploadError } = await supabase.storage
        .from(PATIENT_FILES_BUCKET)
        .upload(path, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type
        });

      if (uploadError) throw new Error(uploadError.message);
      if (storageConfigVersion !== startVersion) {
        await supabase.storage.from(PATIENT_FILES_BUCKET).remove([path]);
        throw new Error('Storage settings changed during upload. Please retry.');
      }

      const { data: publicData } = supabase.storage.from(PATIENT_FILES_BUCKET).getPublicUrl(path);

      return {
        path,
        name: file.name,
        size: file.size,
        type: file.type,
        uploaded_at: new Date().toISOString(),
        url: publicData?.publicUrl || ''
      };
    },

    /**
     * Calculate optimal chunk size for the primary (cloud) Supabase TUS endpoint.
     * Supabase TUS requires chunk sizes that are multiples of 6 MB.
     *
     * Optimised for UNSTABLE internet � uses the smallest valid chunk (6 MB)
     * so each request completes quickly and retries are cheap.
     *
     * NOTE: The self-hosted Supabase path uses its own chunk-size logic inside
     * utils/supabaseStorage.ts ? chooseTusChunkSize().
     *
     * @param fileSize - File size in bytes
     * @returns Optimal chunk size in bytes (6 MB)
     */
    calculateOptimalChunkSize: (fileSize: number): number => {
      void fileSize; // kept for future tuning
      return 6 * 1024 * 1024; // 6 MB � smallest valid TUS chunk
    },

    /**
     * Upload a file using TUS resumable upload protocol with smart adaptive chunking.
     * Automatically adjusts chunk size based on file size to bypass Cloudflare 150MB limit.
     * Supports pause, resume, and cancel operations.
     * Includes automatic retry with smaller chunks if upload fails.
     * 
     * This is ideal for large files and unreliable network connections.
     * Works with both authenticated and public (anon key) uploads based on storage policies.
     *
     * @param patientId - The patient ID to associate the file with
     * @param file - The file to upload
     * @param onProgress - Callback for upload progress (bytesUploaded, bytesTotal)
     * @param onChunkComplete - Callback when a chunk is successfully uploaded
     * @param options - Optional configuration (chunkSize, parallelUploads, etc.)
     * @returns Promise that resolves with the PatientFile when upload is complete
     */
    uploadWithTus: async (
      patientId: string,
      file: File,
      onProgress?: (bytesUploaded: number, bytesTotal: number) => void,
      onChunkComplete?: (chunkSize: number, bytesAccepted: number, bytesTotal: number) => void,
      options?: {
        chunkSize?: number;
        maxRetries?: number;
        metadata?: Record<string, string>;
        attempt?: number;
      }
    ): Promise<PatientFile> => {
      const path = `${patientId}/${Date.now()}-${file.name}`;
      const startVersion = storageConfigVersion;

      console.log('[uploadWithTus] Checking storage settings...');

      // Check Supabase Storage first
      const supabaseStorage = await resolveActiveSupabaseStorage();
      console.log('[uploadWithTus] Supabase Storage resolved:', supabaseStorage ? {
        bucket: supabaseStorage.bucket,
        url: supabaseStorage.storageUrl
      } : 'NOT FOUND');
      
      if (supabaseStorage) {
        console.log('[uploadWithTus] Using Supabase Storage REST API');
        // Use simple upload for Supabase Storage REST API (no TUS support yet)
        await uploadSupabaseStorageFile(
          supabaseStorage,
          path,
          file,
          onProgress,
          onChunkComplete,
          () => storageConfigVersion !== startVersion
        );
        console.log('[uploadWithTus] Supabase Storage upload successful!');
        return {
          path,
          name: file.name,
          size: file.size,
          type: file.type,
          uploaded_at: new Date().toISOString(),
          url: buildSupabasePublicUrl(supabaseStorage.storageUrl, supabaseStorage.bucket, path)
        };
      }

      // Check S3 settings second
      console.log('[uploadWithTus] Checking S3 settings...');
      const s3Settings = await resolveActiveS3Settings();
      console.log('[uploadWithTus] S3 Settings resolved:', s3Settings ? 'Found' : 'Not found');
      if (s3Settings) {
        console.log('[uploadWithTus] Using S3-Compatible API');
        await uploadS3Object(
          s3Settings,
          path,
          file,
          onProgress,
          onChunkComplete,
          () => storageConfigVersion !== startVersion
        );
        const baseUrl = normalizeS3BaseUrl(s3Settings.url);
        return {
          path,
          name: file.name,
          size: file.size,
          type: file.type,
          uploaded_at: new Date().toISOString(),
          url: isSupabaseS3Endpoint(baseUrl)
            ? buildSupabaseS3PublicUrl(baseUrl, path)
            : buildS3FileUrl(baseUrl, path)
        };
      }

      // Get session if available, but don't require it for public uploads
      const { data: { session } } = await supabase.auth.getSession();

      // Use session token if available, otherwise use anon key for public uploads
      // The anon key is used when storage policies allow public access
      const authToken = session?.access_token || supabaseAnonKey;

      // Calculate optimal chunk size if not provided
      const calculatedChunkSize = api.files.calculateOptimalChunkSize(file.size);
      const chunkSize = options?.chunkSize || calculatedChunkSize;
      const maxRetries = options?.maxRetries || 10;
      const attempt = options?.attempt || 1;

      console.log(`[Smart Upload] File: ${file.name}, Size: ${(file.size / 1024 / 1024).toFixed(2)}MB, Chunk Size: ${(chunkSize / 1024 / 1024).toFixed(2)}MB, Attempt: ${attempt}`);

      return new Promise((resolve, reject) => {
        let aborted = false;
        const upload = new tus.Upload(file, {
          endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
          retryDelays: Array.from({ length: maxRetries }, (_, i) => {
            // Exponential backoff: 0s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
            if (i === 0) return 0;
            if (i <= 5) return Math.pow(2, i) * 1000;
            return 60000; // Cap at 60 seconds
          }),
          headers: {
            authorization: `Bearer ${authToken}`,
            'x-upsert': 'false',
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          metadata: {
            bucketName: PATIENT_FILES_BUCKET,
            objectName: path,
            contentType: file.type,
            cacheControl: '3600',
            ...options?.metadata,
          },
          chunkSize,
          onError: async (error) => {
            if (aborted) return;
            console.error(`[Smart Upload] TUS upload error (attempt ${attempt}):`, error);
            const errorMsg = error.message || 'Unknown error';
            
            // If this is not the first attempt and chunk size is still large, retry with smaller chunks
            if (attempt < 3 && chunkSize > 1 * 1024 * 1024 && storageConfigVersion === startVersion) {
              const smallerChunkSize = Math.max(Math.floor(chunkSize / 2), 512 * 1024);
              console.log(`[Smart Upload] Retrying with smaller chunk size: ${(smallerChunkSize / 1024 / 1024).toFixed(2)}MB`);
              
              try {
                const result = await api.files.uploadWithTus(
                  patientId,
                  file,
                  onProgress,
                  onChunkComplete,
                  {
                    ...options,
                    chunkSize: smallerChunkSize,
                    attempt: attempt + 1
                  }
                );
                resolve(result);
                return;
              } catch (retryError) {
                console.error('[Smart Upload] Retry failed:', retryError);
              }
            }
            
            // Handle specific error types
            if (errorMsg.includes('413') || errorMsg.includes('too large')) {
              reject(new Error('File too large for upload. Please try a smaller file or contact support to increase the limit.'));
            } else if (errorMsg.includes('timeout') || errorMsg.includes('network')) {
              reject(new Error('Network timeout. Please check your connection and try again.'));
            } else if (errorMsg.includes('403') || errorMsg.includes('permission')) {
              reject(new Error('Permission denied. Please check storage bucket permissions.'));
            } else {
              reject(new Error(`Upload failed: ${errorMsg}`));
            }
          },
          onProgress: (bytesUploaded, bytesTotal) => {
            if (storageConfigVersion !== startVersion && !aborted) {
              aborted = true;
              upload.abort(true).then(() => {
                reject(new Error('Storage settings changed during upload. Please retry.'));
              }).catch(() => {
                reject(new Error('Storage settings changed during upload. Please retry.'));
              });
              return;
            }
            if (onProgress) {
              onProgress(bytesUploaded, bytesTotal);
            }
          },
          onChunkComplete: (chunkSize, bytesAccepted, bytesTotal) => {
            if (storageConfigVersion !== startVersion && !aborted) {
              aborted = true;
              upload.abort(true).then(() => {
                reject(new Error('Storage settings changed during upload. Please retry.'));
              }).catch(() => {
                reject(new Error('Storage settings changed during upload. Please retry.'));
              });
              return;
            }
            if (onChunkComplete) {
              onChunkComplete(chunkSize, bytesAccepted, bytesTotal);
            }
          },
          onSuccess: () => {
            if (storageConfigVersion !== startVersion) {
              reject(new Error('Storage settings changed during upload. Please retry.'));
              return;
            }
            console.log(`[Smart Upload] Successfully uploaded: ${file.name}`);
            const { data: publicData } = supabase.storage.from(PATIENT_FILES_BUCKET).getPublicUrl(path);

            resolve({
              path,
              name: file.name,
              size: file.size,
              type: file.type,
              uploaded_at: new Date().toISOString(),
              url: publicData?.publicUrl || ''
            });
          },
        });

        // Check for previous uploads to resume
        upload.findPreviousUploads().then((previousUploads) => {
          if (previousUploads.length > 0) {
            console.log('[Smart Upload] Resuming previous upload');
            upload.resumeFromPreviousUpload(previousUploads[0]);
          }
          upload.start();
        }).catch((err) => {
          console.warn('[Smart Upload] Failed to find previous uploads:', err);
          upload.start();
        });
      });
    },

    /**
     * Upload multiple files in parallel with smart chunking.
     * Automatically manages concurrency to optimize upload speed.
     * 
     * @param patientId - The patient ID to associate the files with
     * @param files - Array of files to upload
     * @param onFileProgress - Callback for individual file progress
     * @param onFileComplete - Callback when a file upload completes
     * @param maxConcurrent - Maximum number of concurrent uploads (default: 3)
     * @returns Promise that resolves with array of PatientFile when all uploads complete
     */
    uploadMultipleWithTus: async (
      patientId: string,
      files: File[],
      onFileProgress?: (index: number, fileName: string, bytesUploaded: number, bytesTotal: number) => void,
      onFileComplete?: (index: number, fileName: string, patientFile: any) => void,
      maxConcurrent: number = 3
    ): Promise<any[]> => {
      const results: any[] = [];
      const queue = [...files];
      let index = 0;

      const uploadNext = async (): Promise<void> => {
        if (queue.length === 0) return;

        const file = queue.shift()!;
        const currentIndex = index++;

        console.log(`[Batch Upload] Starting upload ${currentIndex + 1}/${files.length}: ${file.name}`);

        const patientFile = await api.files.uploadWithTus(
          patientId,
          file,
          (bytesUploaded, bytesTotal) => {
            if (onFileProgress) {
              onFileProgress(currentIndex, file.name, bytesUploaded, bytesTotal);
            }
          },
          undefined,
          { chunkSize: api.files.calculateOptimalChunkSize(file.size) }
        );

        results[currentIndex] = patientFile;

        if (onFileComplete) {
          onFileComplete(currentIndex, file.name, patientFile);
        }

        console.log(`[Batch Upload] Completed upload ${currentIndex + 1}/${files.length}: ${file.name}`);

        // Continue with next file in queue
        if (queue.length > 0) {
          await uploadNext();
        }
      };

      // Start concurrent uploads (up to maxConcurrent)
      const workers = Array.from({ length: Math.min(maxConcurrent, files.length) }, () => uploadNext());
      await Promise.all(workers);

      return results;
    },
    remove: async (path: string): Promise<void> => {
      // Check Supabase Storage first
      const supabaseStorage = await resolveActiveSupabaseStorage();
      if (supabaseStorage) {
        await deleteSupabaseStorageFile(supabaseStorage, path);
        return;
      }

      // Check S3 settings second
      const s3Settings = await resolveActiveS3Settings();
      if (s3Settings) {
        await deleteS3Object(s3Settings, path);
        return;
      }

      // Fallback to default Supabase Storage
      const { error } = await supabase.storage
        .from(PATIENT_FILES_BUCKET)
        .remove([path]);

      if (error) throw new Error(error.message);
    }
  },

  expenses: {
    getAll: async (locationId?: string): Promise<Expense[]> => {
      try {
          const { data, error } = await fetchAllRows<Expense>((from, to) => {
            let query = supabase
              .from('expenses')
              .select('*')
              .order('date', { ascending: false })
              .order('id')
              .range(from, to);
            if (locationId) query = query.eq('location_id', locationId);
            return query;
          });
          if (error) throw error;
          const storedExpenses = (data || []) as Expense[];
          const syntheticMaterialExpenses = await fetchSyntheticMaterialCostExpenses(locationId, storedExpenses)
            .catch(() => []);
          return [...storedExpenses, ...syntheticMaterialExpenses]
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        } catch (err) {
          console.warn("Error fetching expenses:", err);
          return [];
        }
      },
    create: async (data: Partial<Expense>): Promise<Expense> => {
      const payload = buildExpensePayload(data);
      const { data: result, error } = await supabase
        .from('expenses')
        .insert(payload)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    update: async (id: string, data: Partial<Expense>): Promise<Expense> => {
      const payload = buildExpensePayload(data, {});
      const { data: result, error } = await supabase
        .from('expenses')
        .update(payload)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('expenses')
        .delete()
        .eq('id', id);
      if (error) throw new Error(error.message);
    }
  },

  users: {
    revokeAuthSession: async (authToken: string): Promise<void> => {
      if (!authToken) return;
      const { error } = await supabase.rpc('revoke_staff_auth_session', {
        p_session_token: authToken
      });
      if (error) throw new Error(error.message || 'Failed to revoke staff session.');
    },
    getById: async (id: string): Promise<User | null> => {
      const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
      const supportsDoctorId = await detectUsersDoctorIdSupport();
      const { data, error } = await supabase
        .from('users')
        .select(supportsAllowedTabs
          ? `id, location_id, username, role, allowed_tabs, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`
          : `id, location_id, username, role, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`)
        .eq('id', id)
        .maybeSingle() as { data: User | null, error: any };

      if (error) throw new Error(error.message);
      if (!data) return null;

      return {
        id: data.id,
        location_id: data.location_id,
        doctor_id: supportsDoctorId ? (data.doctor_id || null) : null,
        username: data.username,
        role: data.role,
        allowed_tabs: resolveAllowedTabs(data.role, supportsAllowedTabs ? data.allowed_tabs : undefined),
        created_at: data.created_at,
        updated_at: data.updated_at
      };
    },
    getByDoctorId: async (doctorId: string): Promise<User | null> => {
      if (!doctorId) return null;

      const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
      const supportsDoctorId = await detectUsersDoctorIdSupport();
      if (!supportsDoctorId) return null;

      const { data, error } = await supabase
        .from('users')
        .select(supportsAllowedTabs
          ? 'id, location_id, username, role, allowed_tabs, created_at, updated_at, doctor_id'
          : 'id, location_id, username, role, created_at, updated_at, doctor_id')
        .eq('doctor_id', doctorId)
        .maybeSingle() as { data: User | null, error: any };

      if (error) throw new Error(error.message);
      if (!data) return null;

      return {
        id: data.id,
        location_id: data.location_id,
        doctor_id: data.doctor_id || null,
        username: data.username,
        role: data.role,
        allowed_tabs: resolveAllowedTabs(data.role, supportsAllowedTabs ? data.allowed_tabs : undefined),
        created_at: data.created_at,
        updated_at: data.updated_at
      };
    },
    getAll: async (locationId?: string): Promise<User[]> => {
      try {
        const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
        const supportsDoctorId = await detectUsersDoctorIdSupport();
        let query = supabase
          .from('users')
          .select(supportsAllowedTabs
            ? `id, location_id, username, role, allowed_tabs, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`
            : `id, location_id, username, role, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`)
          .order('created_at', { ascending: false });

        if (locationId) {
          query = query.or(`location_id.eq.${locationId},location_id.is.null`);
        }

        const { data, error } = await query;
        
        if (error) throw error;
        return (data || []).map((u: any) => ({
          id: u.id,
          location_id: u.location_id,
          doctor_id: supportsDoctorId ? (u.doctor_id || null) : null,
          username: u.username,
          role: u.role,
          allowed_tabs: resolveAllowedTabs(u.role, supportsAllowedTabs ? u.allowed_tabs : undefined),
          created_at: u.created_at,
          updated_at: u.updated_at
        }));
      } catch (err) {
        console.warn("Error fetching users:", err);
        return [];
      }
    },
    authenticate: async (username: string, password: string): Promise<User | null> => {
      try {
        const trimmedUsername = username.trim();
        const passwordMatches = (storedPassword?: string | null) => (
          String(storedPassword || '') === password ||
          String(storedPassword || '').trim() === password.trim()
        );
        console.log('Attempting to authenticate user:', trimmedUsername);
        const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
        const supportsDoctorId = await detectUsersDoctorIdSupport();
        const selectColumns = supportsAllowedTabs
          ? `id, location_id, username, role, allowed_tabs${supportsDoctorId ? ', doctor_id' : ''}`
          : `id, location_id, username, role${supportsDoctorId ? ', doctor_id' : ''}`;
        const mapUserForSession = (user: User): User => ({
          id: user.id,
          location_id: user.location_id,
          doctor_id: supportsDoctorId ? (user.doctor_id || null) : null,
          username: user.username,
          auth_session_token: user.auth_session_token,
          role: user.role,
          allowed_tabs: resolveAllowedTabs(user.role, supportsAllowedTabs ? user.allowed_tabs : undefined)
        });
  
        const authResult = await supabase.rpc('authenticate_staff_user_session', {
          p_username: trimmedUsername,
          p_password: password
        });
        const data = authResult.data as User[] | null;
        const error = authResult.error;

        if (error) {
          console.error('Supabase error:', error);
          return null;
        }

        const user = (data || []).find((row) => row.username === trimmedUsername)
          || (data || []).find((row) => row.username?.toLowerCase() === trimmedUsername.toLowerCase())
          || (data || [])[0];

        if (user) {
          console.log('Authentication successful for user:', trimmedUsername);
          return mapUserForSession(user);
        }

        if (!user) {
          console.log('No user found with username:', trimmedUsername);
        } else {
          console.log('Password mismatch for user:', trimmedUsername);
        }

        if (supportsDoctorId) {
          const { data: doctorRows, error: doctorError } = await supabase
            .from('doctors')
            .select('id, location_id, email, password')
            .ilike('email', trimmedUsername)
            .limit(1);

          if (doctorError) {
            console.warn('Doctor email login fallback failed:', doctorError.message);
            return null;
          }

          const doctor = doctorRows?.[0];
          if (doctor && passwordMatches(doctor.password)) {
            const { data: linkedUser, error: linkedUserError } = await supabase
              .from('users')
              .select(selectColumns)
              .eq('doctor_id', doctor.id)
              .maybeSingle() as { data: User | null, error: any };

            if (linkedUserError) {
              console.warn('Doctor email matched, but linked staff user lookup failed:', linkedUserError.message);
              throw new Error('Unable to verify the linked doctor login account. Please try again.');
            }

            if (linkedUser) {
              console.log('Authentication successful for doctor email:', trimmedUsername);
              return {
                ...mapUserForSession(linkedUser),
                doctor_id: doctor.id,
                allowed_tabs: DOCTOR_DASHBOARD_TABS
              };
            }

            console.log('Authentication successful for doctor email without linked staff user:', trimmedUsername);
            throw new Error('This doctor login account is incomplete. Please ask an administrator to update the doctor account.');
          }
        }

        return null;
      } catch (err) {
        console.error("Error authenticating user:", err);
        throw err;
      }
    },
    create: async (data: Partial<User>): Promise<User> => {
      const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
      const supportsDoctorId = await detectUsersDoctorIdSupport();
      const trimmedUsername = data.username?.trim();
      if (!trimmedUsername) {
        throw new Error('Username is required');
      }

      // Check if username already exists
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('username', trimmedUsername)
        .single();

      if (existing) {
        throw new Error('Username already exists');
      }

      const payload = {
        location_id: data.location_id || null,
        username: trimmedUsername,
        password: data.password, // In production, hash this
        role: data.role || 'normal'
      };

      if (supportsDoctorId && data.doctor_id !== undefined) {
        (payload as any).doctor_id = data.doctor_id || null;
      }

      if (supportsAllowedTabs) {
        (payload as any).allowed_tabs = data.role === 'admin'
          ? FULL_ACCESS_TAB_PERMISSIONS
          : resolveAllowedTabs(data.role || 'normal', data.allowed_tabs);
      }

      const { data: result, error } = await supabase
        .from('users')
        .insert(payload)
        .select(supportsAllowedTabs
          ? `id, location_id, username, role, allowed_tabs, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`
          : `id, location_id, username, role, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`)
        .single() as { data: User, error: any };

      if (error) throw new Error(error.message);
      return {
        id: result.id,
        location_id: result.location_id,
        doctor_id: supportsDoctorId ? (result.doctor_id || null) : null,
        username: result.username,
        role: result.role,
        allowed_tabs: resolveAllowedTabs(result.role, supportsAllowedTabs ? result.allowed_tabs : undefined),
        created_at: result.created_at,
        updated_at: result.updated_at
      };
    },
    update: async (id: string, data: Partial<User>): Promise<User> => {
      const supportsAllowedTabs = await detectUsersAllowedTabsSupport();
      const supportsDoctorId = await detectUsersDoctorIdSupport();
      const payload: any = {};
      const { data: currentUser, error: currentUserError } = await supabase
        .from('users')
        .select(supportsAllowedTabs ? 'role, allowed_tabs' : 'role')
        .eq('id', id)
        .single() as { data: User, error: any };

      if (currentUserError) {
        throw new Error(currentUserError.message);
      }

      if (data.username !== undefined) {
        const trimmedUsername = data.username.trim();
        if (!trimmedUsername) {
          throw new Error('Username cannot be empty');
        }

        // Check if username already exists (excluding current user)
        const { data: existing } = await supabase
          .from('users')
          .select('id')
          .eq('username', trimmedUsername)
          .neq('id', id)
          .single() as { data: { id: string } | null, error: any };

        if (existing) {
          throw new Error('Username already exists');
        }
        payload.username = trimmedUsername;
      }
      
      if (data.password !== undefined && data.password !== '') {
        payload.password = data.password; // In production, hash this
      }
      
      if (data.role !== undefined) {
        payload.role = data.role;
      }

      if (data.location_id !== undefined) {
        payload.location_id = data.location_id || null;
      }

      if (supportsDoctorId && data.doctor_id !== undefined) {
        payload.doctor_id = data.doctor_id || null;
      }

      if (supportsAllowedTabs && (data.allowed_tabs !== undefined || data.role !== undefined)) {
        const nextRole = (data.role || currentUser.role) as User['role'];
        const nextAllowedTabs = nextRole === 'admin'
          ? FULL_ACCESS_TAB_PERMISSIONS
          : resolveAllowedTabs(nextRole, data.allowed_tabs ?? currentUser.allowed_tabs);
        payload.allowed_tabs = nextAllowedTabs;
      }

      payload.updated_at = new Date().toISOString();

      const { data: result, error } = await supabase
        .from('users')
        .update(payload)
        .eq('id', id)
        .select(supportsAllowedTabs
          ? `id, location_id, username, role, allowed_tabs, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`
          : `id, location_id, username, role, created_at, updated_at${supportsDoctorId ? ', doctor_id' : ''}`)
        .single() as { data: User, error: any };

      if (error) throw new Error(error.message);
      return {
        id: result.id,
        location_id: result.location_id,
        doctor_id: supportsDoctorId ? (result.doctor_id || null) : null,
        username: result.username,
        role: result.role,
        allowed_tabs: resolveAllowedTabs(result.role, supportsAllowedTabs ? result.allowed_tabs : undefined),
        created_at: result.created_at,
        updated_at: result.updated_at
      };
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
    }
  },

  activeStaffSessions: {
    getActive: async (): Promise<ActiveStaffMonitorEntry[]> => {
      try {
        const cleanupResult = await supabase.rpc('cleanup_stale_active_staff_sessions', { p_cutoff_minutes: 60 });
        if (cleanupResult.error && !isMissingFunctionError(cleanupResult.error, 'cleanup_stale_active_staff_sessions')) {
          throw cleanupResult.error;
        }

        const activeThreshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('active_staff_sessions')
          .select('session_id, user_id, username_snapshot, role_snapshot, location_id, login_at, last_seen')
          .gte('last_seen', activeThreshold)
          .in('role_snapshot', ['admin', 'normal', 'doctor'])
          .order('last_seen', { ascending: false });

        if (error) {
          if (isMissingRelationError(error, 'active_staff_sessions')) {
            return [];
          }
          throw error;
        }

        const sessionRows = (data || []) as Array<{
          session_id: string;
          user_id: string;
          username_snapshot: string;
          role_snapshot: 'admin' | 'normal' | 'doctor';
          location_id: string | null;
          login_at: string;
          last_seen: string;
        }>;

        const latestByUserId = new Map<string, typeof sessionRows[number]>();
        for (const row of sessionRows) {
          const existing = latestByUserId.get(row.user_id);
          if (!existing || new Date(row.last_seen).getTime() > new Date(existing.last_seen).getTime()) {
            latestByUserId.set(row.user_id, row);
          }
        }

        const latestSessions = Array.from(latestByUserId.values());
        if (latestSessions.length === 0) {
          return [];
        }

        const userIds = Array.from(new Set(latestSessions.map((row) => row.user_id).filter(Boolean)));
        const locationIds = Array.from(new Set(latestSessions.map((row) => row.location_id).filter(Boolean))) as string[];

        const [usersResult, doctorsResult, locationsResult] = await Promise.all([
          supabase
            .from('users')
            .select('id, username, location_id, doctor_id')
            .in('id', userIds),
          supabase
            .from('doctors')
            .select('id, name, email, phone'),
          locationIds.length > 0
            ? supabase.from('locations').select('id, name').in('id', locationIds)
            : Promise.resolve({ data: [], error: null })
        ]);

        if (usersResult.error && !isMissingRelationError(usersResult.error, 'users')) {
          throw usersResult.error;
        }
        if (doctorsResult.error && !isMissingRelationError(doctorsResult.error, 'doctors')) {
          throw doctorsResult.error;
        }
        if (locationsResult.error && !isMissingRelationError(locationsResult.error, 'locations')) {
          throw locationsResult.error;
        }

        const usersById = new Map(
          ((usersResult.data || []) as Array<{ id: string; username: string; location_id: string | null; doctor_id?: string | null }>).map((user) => [user.id, user])
        );
        const doctorsById = new Map(
          ((doctorsResult.data || []) as Array<{ id: string; name?: string | null; email?: string | null; phone?: string | null }>).map((doctor) => [doctor.id, doctor])
        );
        const locationsById = new Map(
          ((locationsResult.data || []) as Array<{ id: string; name: string }>).map((location) => [location.id, location.name])
        );

        return latestSessions.map((row) => {
          const user = usersById.get(row.user_id);
          const doctor = user?.doctor_id ? doctorsById.get(user.doctor_id) : undefined;
          const resolvedLocationId = user?.location_id ?? row.location_id ?? null;

          return {
            session_id: row.session_id,
            user_id: row.user_id,
            username: user?.username || row.username_snapshot,
            role: row.role_snapshot,
            location_id: resolvedLocationId,
            location_name: resolvedLocationId ? (locationsById.get(resolvedLocationId) || null) : null,
            display_name: row.role_snapshot === 'doctor'
              ? (doctor?.name || user?.username || row.username_snapshot)
              : (user?.username || row.username_snapshot),
            email: row.role_snapshot === 'doctor' ? (doctor?.email || null) : null,
            phone: row.role_snapshot === 'doctor' ? (doctor?.phone || null) : null,
            login_at: row.login_at,
            last_seen: row.last_seen
          } satisfies ActiveStaffMonitorEntry;
        });
      } catch (err) {
        console.warn('Error fetching active staff sessions:', err);
        return [];
      }
    }
  },

  medicines: {
    getAll: async (locationId?: string): Promise<Medicine[]> => {
      try {
        let query = supabase
          .from('medicines')
          .select('*')
          .order('name');
        
        if (locationId) {
          query = query.eq('location_id', locationId);
        }

        const { data, error } = await query;
        
        if (error) throw error;
        return (data || []).map((m: any) => ({
          id: m.id,
          location_id: m.location_id,
          name: m.name,
          description: m.description,
          unit: m.unit,
          item_type: m.item_type || 'Medicine',
          price: m.price,
          stock: m.stock,
          min_stock: m.min_stock,
          quantity_step: Number(m.quantity_step || 1),
          category: m.category,
          created_at: m.created_at,
          updated_at: m.updated_at
        }));
      } catch (err) {
        console.warn("Error fetching medicines:", err);
        return [];
      }
    },
    getById: async (id: string): Promise<Medicine | null> => {
      try {
        const { data, error } = await supabase
          .from('medicines')
          .select('*')
          .eq('id', id)
          .single();
        
        if (error) throw error;
        if (!data) return null;
        
        return {
          id: data.id,
          location_id: data.location_id,
          name: data.name,
          description: data.description,
          unit: data.unit,
          item_type: data.item_type || 'Medicine',
          price: data.price,
          stock: data.stock,
          min_stock: data.min_stock,
          quantity_step: Number(data.quantity_step || 1),
          category: data.category,
          created_at: data.created_at,
          updated_at: data.updated_at
        };
      } catch (err) {
        console.warn("Error fetching medicine:", err);
        return null;
      }
    },
    create: async (data: Partial<Medicine>): Promise<Medicine> => {
      const payload = buildMedicinePayload(data);

      const { data: result, error } = await supabase
        .from('medicines')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return {
        id: result.id,
        location_id: result.location_id,
        name: result.name,
        description: result.description,
        unit: result.unit,
        item_type: result.item_type || 'Medicine',
        price: result.price,
        stock: result.stock,
        min_stock: result.min_stock,
        quantity_step: Number(result.quantity_step || 1),
        category: result.category,
        created_at: result.created_at,
        updated_at: result.updated_at
      };
    },
    update: async (id: string, data: Partial<Medicine>): Promise<Medicine> => {
      const payload: any = buildMedicinePayload(data, {});
      
      payload.updated_at = new Date().toISOString();

      const { data: result, error } = await supabase
        .from('medicines')
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return {
        id: result.id,
        location_id: result.location_id,
        name: result.name,
        description: result.description,
        unit: result.unit,
        item_type: result.item_type || 'Medicine',
        price: result.price,
        stock: result.stock,
        min_stock: result.min_stock,
        quantity_step: Number(result.quantity_step || 1),
        category: result.category,
        created_at: result.created_at,
        updated_at: result.updated_at
      };
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('medicines')
        .delete()
        .eq('id', id);

      if (error) throw new Error(error.message);
    },
    sell: async (patientId: string, medicineId: string, quantity: number, locationId: string, treatmentId?: string, finalTotal?: number): Promise<{ sale: MedicineSale; new_stock: number }> => {
      if (!locationId) throw new Error('locationId is required for medicine sales');
      const parsedQuantity = Number(quantity);
      if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
        throw new Error('Quantity must be greater than 0');
      }
      const parsedFinalTotal = finalTotal === undefined ? null : Number(finalTotal);
      if (parsedFinalTotal !== null && (!Number.isFinite(parsedFinalTotal) || parsedFinalTotal < 0)) {
        throw new Error('Final medicine charge must be at least 0');
      }

      const { data: rpcResult, error } = await supabase.rpc('sell_medicine_atomic', {
        p_location_id: locationId,
        p_patient_id: patientId,
        p_medicine_id: medicineId,
        p_quantity: parsedQuantity,
        p_treatment_id: treatmentId || null,
        p_sale_date: getLocalISODate(),
        p_final_total: parsedFinalTotal
      });

      if (error) {
        if (isMissingFunctionError(error, 'sell_medicine_atomic')) {
          throw new Error('Atomic medicine sales are not installed. Apply the atomic clinical workflows migration before selling medicine.');
        }
        throw new Error(error.message);
      }

      const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
      if (!result?.sale) throw new Error('Medicine sale returned no record.');

      return {
        sale: {
          ...result.sale,
          quantity: Number(result.sale.quantity),
          unit_price: Number(result.sale.unit_price),
          total_price: Number(result.sale.total_price),
          standard_total: Number(result.sale.standard_total ?? result.sale.total_price),
          discount_amount: Number(result.sale.discount_amount || 0),
          pricing_note: result.sale.pricing_note || null
        },
        new_stock: Number(result.new_stock)
      };
    },
    undoSale: async (saleId: string): Promise<{
      medicine_sale_id: string;
      medicine_id: string;
      patient_id: string;
      quantity_restocked: number;
      new_stock: number;
      new_balance: number;
      new_points: number;
      reversed_points: number;
      loyalty_reversal: LoyaltyTransaction | null;
    }> => {
      const { data, error } = await supabase.rpc('undo_medicine_sale_atomic', {
        p_medicine_sale_id: saleId
      });
      if (error) {
        if (isMissingFunctionError(error, 'undo_medicine_sale_atomic')) {
          throw new Error('Atomic medicine record undo is not installed. Apply the medicine record undo migration before deleting medicine records.');
        }
        throw new Error(error.message);
      }

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.medicine_sale_id) throw new Error('Medicine record undo returned no result.');
      return {
        ...result,
        quantity_restocked: Number(result.quantity_restocked),
        new_stock: Number(result.new_stock),
        new_balance: Number(result.new_balance),
        new_points: Number(result.new_points),
        reversed_points: Number(result.reversed_points || 0),
        loyalty_reversal: result.loyalty_reversal || null
      };
    },
    getSales: async (locationId?: string, patientId?: string, options?: { throwOnError?: boolean }): Promise<MedicineSale[]> => {
      try {
        const buildSalesQuery = (columns: string) => (from: number, to: number) => {
          let query = supabase
            .from('medicine_sales')
            .select(columns)
            .order('date', { ascending: false })
            .order('id')
            .range(from, to);
          if (locationId) query = query.eq('location_id', locationId);
          if (patientId) query = query.eq('patient_id', patientId);
          return query;
        };

        // A patient chart already has the patient identity. Avoid joining patients and
        // transferring write-only sale fields that Clinical Focus never consumes.
        const patientHistoryColumns = 'id, location_id, patient_id, medicine_id, quantity, unit_price, total_price, standard_total, discount_amount, pricing_note, date, treatment_id, created_at, medicines(name, unit)';
        const columns = patientId
          ? patientHistoryColumns
          : '*, patients(name), medicines(name, unit)';
        let { data, error } = await fetchAllRows<any>(buildSalesQuery(columns));

        if (error && isOptionalRelationAccessError(error, ['patients', 'medicines'])) {
          const fallbackColumns = patientId
            ? 'id, location_id, patient_id, medicine_id, quantity, unit_price, total_price, standard_total, discount_amount, pricing_note, date, treatment_id, created_at'
            : '*';
          const fallback = await fetchAllRows<any>(buildSalesQuery(fallbackColumns));
          data = fallback.data;
          error = fallback.error;
        }

        if (error) throw error;

        return (data || []).map((sale: any) => ({
          id: sale.id,
          location_id: sale.location_id,
          patient_id: sale.patient_id,
          patient_name: sale.patients?.name || 'Unknown',
          medicine_id: sale.medicine_id,
          medicine_name: sale.medicines?.name || 'Unknown',
          medicine_unit: sale.medicines?.unit || undefined,
          quantity: Number(sale.quantity),
          unit_price: Number(sale.unit_price),
          total_price: Number(sale.total_price),
          standard_total: Number(sale.standard_total ?? sale.total_price),
          discount_amount: Number(sale.discount_amount || 0),
          pricing_note: sale.pricing_note || null,
          date: sale.date,
          treatment_id: sale.treatment_id,
          created_at: sale.created_at
        }));
      } catch (err) {
        console.warn("Error fetching medicine sales:", err);
        if (options?.throwOnError) throw err;
        return [];
      }
    },
    getTopSelling: async (locationId?: string, limit: number = 10): Promise<{ medicine_id: string; medicine_name: string; total_quantity: number; total_revenue: number }[]> => {
      try {
        const buildTopSellingQuery = (columns: string) => (from: number, to: number) => {
          let query = supabase
            .from('medicine_sales')
            .select(columns)
            .order('id')
            .range(from, to);
          if (locationId) query = query.eq('location_id', locationId);
          return query;
        };
        const initialResult = await fetchAllRows<any>(buildTopSellingQuery('medicine_id, medicines(name), quantity, total_price'));
        let data: any[] | null = initialResult.data;
        let error: any = initialResult.error;

        if (error && isOptionalRelationAccessError(error, ['medicines'])) {
          const fallback = await fetchAllRows<any>(buildTopSellingQuery('medicine_id, quantity, total_price'));
          data = fallback.data;
          error = fallback.error;
        }

        if (error) throw error;

        // Aggregate sales by medicine
        const salesMap = new Map<string, { medicine_id: string; medicine_name: string; total_quantity: number; total_revenue: number }>();

        (data || []).forEach((sale: any) => {
          const medId = sale.medicine_id;
          const medName = sale.medicines?.name || 'Unknown';
          
          if (!salesMap.has(medId)) {
            salesMap.set(medId, {
              medicine_id: medId,
              medicine_name: medName,
              total_quantity: 0,
              total_revenue: 0
            });
          }
          
          const entry = salesMap.get(medId)!;
          entry.total_quantity += sale.quantity || 0;
          entry.total_revenue += sale.total_price || 0;
        });

        // Convert to array, sort by quantity sold, and limit
        return Array.from(salesMap.values())
          .sort((a, b) => b.total_quantity - a.total_quantity)
          .slice(0, limit);
      } catch (err) {
        console.warn("Error fetching top selling medicines:", err);
        return [];
      }
    }
  },

  // Doctor Schedules API
  doctorSchedules: {
    getByDoctorId: async (doctorId: string): Promise<DoctorSchedule[]> => {
      try {
        const { data, error } = await supabase
          .from('doctor_schedules')
          .select('*')
          .eq('doctor_id', doctorId)
          .order('day_of_week');
        
        if (error) throw error;
        return (data || []).map((sched: any) => ({
          id: sched.id,
          doctor_id: sched.doctor_id,
          day_of_week: sched.day_of_week,
          start_time: sched.start_time,
          end_time: sched.end_time
        }));
      } catch (err) {
        console.warn("Error fetching doctor schedules:", err);
        return [];
      }
    },
    create: async (data: Partial<DoctorSchedule>): Promise<DoctorSchedule> => {
      const { data: result, error } = await supabase
        .from('doctor_schedules')
        .insert(data)
        .select()
        .single();
      
      if (error) throw new Error(error.message);
      return {
        id: result.id,
        doctor_id: result.doctor_id,
        day_of_week: result.day_of_week,
        start_time: result.start_time,
        end_time: result.end_time
      };
    },
    update: async (id: string, data: Partial<DoctorSchedule>): Promise<DoctorSchedule> => {
      const { data: result, error } = await supabase
        .from('doctor_schedules')
        .update(data)
        .eq('id', id)
        .select()
        .single();
      
      if (error) throw new Error(error.message);
      return {
        id: result.id,
        doctor_id: result.doctor_id,
        day_of_week: result.day_of_week,
        start_time: result.start_time,
        end_time: result.end_time
      };
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('doctor_schedules')
        .delete()
        .eq('id', id);
      
      if (error) throw new Error(error.message);
    }
  },

  // Treatment Types API
  treatmentTypes: {
    getAll: async (locationId?: string): Promise<TreatmentType[]> => {
      try {
        let query = supabase
          .from('treatment_types')
          .select('*')
          .order('name');
        
        if (locationId) {
          query = query.eq('location_id', locationId);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn("Error fetching treatment types:", err);
        return [];
      }
    },
    create: async (data: Partial<TreatmentType>): Promise<TreatmentType> => {
      const { data: result, error } = await supabase
        .from('treatment_types')
        .insert(data)
        .select()
        .single();
      
      if (error) throw new Error(error.message);
      return result;
    },
    update: async (id: string, data: Partial<TreatmentType>): Promise<TreatmentType> => {
      const { data: result, error } = await supabase
        .from('treatment_types')
        .update(data)
        .eq('id', id)
        .select()
        .single();
      
      if (error) throw new Error(error.message);
      return result;
    },
    delete: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('treatment_types')
        .delete()
        .eq('id', id);
      
      if (error) throw new Error(error.message);
    }
  },

  // Loyalty API
  loyalty: {
    getTransactions: async (patientId: string, locationId?: string): Promise<LoyaltyTransaction[]> => {
      try {
        const { data, error } = await fetchAllRows<LoyaltyTransaction>((from, to) => {
          let query = supabase
            .from('loyalty_transactions')
            .select('*')
            .eq('patient_id', patientId)
            .order('date', { ascending: false })
            .order('id')
            .range(from, to);
          if (locationId) query = query.eq('location_id', locationId);
          return query;
        });
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn("Error fetching loyalty transactions:", err);
        return [];
      }
    },
    addTransaction: async (data: Partial<LoyaltyTransaction>): Promise<LoyaltyTransaction> => {
      const payload = {
        patient_id: data.patient_id,
        location_id: data.location_id,
        points: data.points,
        type: data.type,
        description: data.description,
        date: new Date().toISOString()
      };
      const { data: result, error } = await supabase
        .from('loyalty_transactions')
        .insert(payload)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    redeemPoints: async (patientId: string, locationId: string, points: number, amount: number) => {
      // Fetch current points
      const { data: patient, error: fetchError } = await supabase
        .from('patients')
        .select('loyalty_points, balance')
        .eq('id', patientId)
        .single();

      if (fetchError) throw new Error(fetchError.message);
      if ((patient?.loyalty_points || 0) < points) {
        throw new Error('Insufficient loyalty points');
      }

      const newPoints = patient.loyalty_points - points;
      const newBalance = Math.max(0, (patient.balance || 0) - amount);

      const { error: updateError } = await supabase
        .from('patients')
        .update({ loyalty_points: newPoints, balance: newBalance })
        .eq('id', patientId);

      if (updateError) throw new Error(updateError.message);

      const redeemDescription = amount > 0
        ? `Redeemed ${points} points for discount of ${amount}`
        : `Redeemed ${points} points`;

      await api.loyalty.addTransaction({
        patient_id: patientId,
        location_id: locationId,
        points: -points,
        type: 'REDEEMED',
        description: redeemDescription
      });

      return { status: 'success', new_points: newPoints, new_balance: newBalance };
    },
    getRules: async (locationId?: string): Promise<LoyaltyRule[]> => {
      try {
        let query = supabase.from('loyalty_rules').select('*').order('name');
        if (locationId) {
          query = query.eq('location_id', locationId);
        }
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn("Error fetching loyalty rules:", err);
        return [];
      }
    },
    updateRule: async (id: string, data: Partial<LoyaltyRule>): Promise<LoyaltyRule> => {
      const { data: result, error } = await supabase
        .from('loyalty_rules')
        .update(data)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    createRule: async (data: Partial<LoyaltyRule>): Promise<LoyaltyRule> => {
      const { data: result, error } = await supabase
        .from('loyalty_rules')
        .insert(data)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return result;
    },
    deleteRule: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('loyalty_rules')
        .delete()
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    resetAllPoints: async (locationId?: string): Promise<void> => {
      let patientQuery = supabase
        .from('patients')
        .update({ loyalty_points: 0 })
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (locationId) {
        patientQuery = patientQuery.eq('location_id', locationId);
      }

      const { error: patientError } = await patientQuery;
      
      if (patientError) throw new Error(patientError.message);

      let txQuery = supabase
        .from('loyalty_transactions')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (locationId) {
        txQuery = txQuery.eq('location_id', locationId);
      }

      const { error: txError } = await txQuery;

      if (txError) throw new Error(txError.message);
    }
  },
  
  // Planning & Audit Utilities
  planning: {
    getPatientState: async (patientId: string, locationId: string) => {
      const { data, error } = await supabase
        .from('patients')
        .select('id, name, balance, loyalty_points, medical_history')
        .eq('id', patientId)
        .eq('location_id', locationId)
        .single();
      if (error) throw new Error(`Planning error: ${error.message}`);
      return data;
    },
    getMedicineState: async (medicineId: string, locationId: string) => {
      const { data, error } = await supabase
        .from('medicines')
        .select('id, name, stock, price, min_stock, quantity_step')
        .eq('id', medicineId)
        .eq('location_id', locationId)
        .single();
      if (error) throw new Error(`Planning error: ${error.message}`);
      return data;
    },
    getDoctorAvailability: async (doctorId: string, date: string) => {
      const dayOfWeek = new Date(date).getDay();
      const { data: schedules, error: sError } = await supabase
        .from('doctor_schedules')
        .select('*')
        .eq('doctor_id', doctorId)
        .eq('day_of_week', dayOfWeek);
      
      if (sError) throw new Error(`Planning error: ${sError.message}`);
      
      const { data: appointments, error: aError } = await supabase
        .from('appointments')
        .select('time')
        .eq('doctor_id', doctorId)
        .eq('date', date)
        .eq('status', 'Scheduled');
      
      if (aError) throw new Error(`Planning error: ${aError.message}`);
      
      return { schedules, appointments };
    }
  },

  messages: {
    mapConversationRow: (conv: any, unreadCount = 0, doctorNameByUserId: Record<string, string> = {}): Conversation => {
      const patientName = conv.patients?.name || (Array.isArray(conv.patients) ? conv.patients[0]?.name : undefined);
      const adminName = conv.admin_user?.username || (Array.isArray(conv.admin_user) ? conv.admin_user[0]?.username : 'Unknown Admin');
      const doctorUserId = conv.doctor_user_id || null;
      const doctorName = doctorUserId ? (doctorNameByUserId[doctorUserId] || conv.doctor_user?.username || 'Doctor') : null;
      const participantType: 'patient' | 'doctor' = conv.patient_id ? 'patient' : 'doctor';
      const participantName = participantType === 'patient'
        ? (patientName || 'Unknown Patient')
        : (doctorName || 'Doctor');

      return {
        id: conv.id,
        patient_id: conv.patient_id || null,
        doctor_user_id: doctorUserId,
        participant_type: participantType,
        participant_name: participantName,
        patient_name: participantName,
        admin_id: conv.admin_id,
        admin_name: adminName,
        last_message: conv.last_message,
        last_message_time: conv.last_message_time,
        unread_count: unreadCount,
        created_at: conv.created_at
      };
    },

    // Get conversations for a user
    getConversations: async (userId: string, userType: 'patient' | 'admin', locationId?: string): Promise<Conversation[]> => {
      // Perform automatic cleanup before fetching conversations
      await api.messages.performAutomaticCleanup();
      
      // Validate userId is a proper UUID (not 'undefined' or 'admin-default')
      if (!userId || userId === 'undefined' || userId === 'admin-default') {
        console.warn('Invalid user ID for conversations:', userId);
        return [];
      }
      
      const supportsDoctorMessaging = await detectConversationsDoctorUserSupport();
      const selectClause = supportsDoctorMessaging
        ? `
          id,
          patient_id,
          doctor_user_id,
          patients(name),
          admin_id,
          admin_user:users!conversations_admin_id_fkey(username),
          last_message,
          last_message_time,
          created_at
        `
        : `
          id,
          patient_id,
          patients(name),
          admin_id,
          admin_user:users!conversations_admin_id_fkey(username),
          last_message,
          last_message_time,
          created_at
        `;

      const { data: conversations, error } = await fetchAllRows<any>((from, to) => {
        let query = supabase
          .from('conversations')
          .select(selectClause)
          .order('last_message_time', { ascending: false, nullsFirst: false })
          .order('id')
          .range(from, to);
        query = userType === 'patient' ? query.eq('patient_id', userId) : query.eq('admin_id', userId);
        if (locationId) {
          // Include conversations for this branch OR conversations without a location
          // (created before the branch feature was added)
          query = query.or(`location_id.eq.${locationId},location_id.is.null`);
        }
        return query;
      });
      
      if (error) throw new Error(error.message);

      if (!conversations || conversations.length === 0) {
        return [];
      }

      const doctorUserIds = supportsDoctorMessaging
        ? Array.from(new Set(conversations.map((conv: any) => conv.doctor_user_id).filter(Boolean)))
        : [];
      const doctorNameByUserId: Record<string, string> = {};
      if (doctorUserIds.length > 0) {
        const { data: doctorUsers, error: doctorUsersError } = await supabase
          .from('users')
          .select('id, username, doctor_id')
          .in('id', doctorUserIds);

        if (!doctorUsersError && doctorUsers) {
          const doctorIds = Array.from(new Set(doctorUsers.map((user: any) => user.doctor_id).filter(Boolean)));
          const doctorNameByDoctorId: Record<string, string> = {};
          if (doctorIds.length > 0) {
            const { data: doctorsData, error: doctorsError } = await supabase
              .from('doctors')
              .select('id, name')
              .in('id', doctorIds);

            if (!doctorsError && doctorsData) {
              doctorsData.forEach((doctor: any) => {
                doctorNameByDoctorId[doctor.id] = doctor.name;
              });
            }
          }

          doctorUsers.forEach((user: any) => {
            doctorNameByUserId[user.id] = doctorNameByDoctorId[user.doctor_id] || user.username || 'Doctor';
          });
        }
      }
      
      // Get unread message counts for each conversation
      const conversationIds = conversations.map((conv: any) => conv.id);
      const unreadMessages: any[] = [];
      let unreadError: any = null;
      for (let index = 0; index < conversationIds.length; index += 25) {
        const conversationIdBatch = conversationIds.slice(index, index + 25);
        const result = await fetchAllRows<any>((from, to) => supabase
          .from('messages')
          .select('id, conversation_id, recipient_id, recipient_type, read')
          .in('conversation_id', conversationIdBatch)
          .eq('recipient_id', userId)
          .eq('recipient_type', userType)
          .eq('read', false)
          .order('id')
          .range(from, to));
        if (result.error) {
          unreadError = result.error;
          break;
        }
        unreadMessages.push(...(result.data || []));
      }
      
      if (unreadError) {
        console.warn('Error fetching unread message counts:', unreadError.message);
        // Return conversations with 0 unread count if unread query fails
        return conversations.map((conv: any) => api.messages.mapConversationRow(conv, 0, doctorNameByUserId));
      }
      
      // Create a map of conversation_id to unread count
      const unreadCountMap = unreadMessages.reduce((acc: Record<string, number>, msg: any) => {
        acc[msg.conversation_id] = (acc[msg.conversation_id] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      return conversations.map((conv: any) => api.messages.mapConversationRow(conv, unreadCountMap[conv.id] || 0, doctorNameByUserId));
    },
    
    // Get messages for a conversation
    getMessages: async (conversationId: string): Promise<Message[]> => {
      // Perform automatic cleanup before fetching messages
      await api.messages.performAutomaticCleanup();
      
      const { data, error } = await fetchAllRows<Message>((from, to) => supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('timestamp', { ascending: true })
        .order('id')
        .range(from, to));
      
      if (error) throw new Error(error.message);
      return data || [];
    },
    
    // Create new message
    createMessage: async (message: Omit<Message, 'id' | 'timestamp' | 'read'>): Promise<Message> => {
      // Validate required UUID fields
      if (!message.conversation_id || message.conversation_id === 'undefined' ||
          !message.sender_id || message.sender_id === 'undefined' || message.sender_id === 'admin-default' ||
          !message.recipient_id || message.recipient_id === 'undefined' || message.recipient_id === 'admin-default') {
        throw new Error('Invalid UUID fields in message data');
      }
      
      const newMessage = {
        ...message,
        timestamp: new Date().toISOString(),
        read: false
      };
      
      const { data: messageData, error: messageError } = await supabase
        .from('messages')
        .insert(newMessage)
        .select()
        .single();
      
      if (messageError) throw new Error(messageError.message);
      
      return messageData;
    },

    sendAdminReplyNotification: async (params: {
      message: Message;
      patientName?: string;
      adminName?: string;
    }): Promise<void> => {
      const { message, patientName, adminName } = params;

      if (message.sender_type !== 'admin' || message.recipient_type !== 'patient') {
        return;
      }

      const emailSettings = await loadEmailSettingsAsync();
      if (!emailSettings.enabled || !emailSettings.messageNotificationsEnabled) {
        return;
      }

      if (!emailSettings.senderEmail || !isValidEmailAddress(emailSettings.senderEmail)) {
        console.warn('Skipping patient reply notification because the sender email is not configured.');
        return;
      }

      const { data: patientRecord, error: patientError } = await supabase
        .from('patients')
        .select('name, email, location_id')
        .eq('id', message.recipient_id)
        .maybeSingle();

      if (patientError) {
        throw new Error(patientError.message);
      }

      const patientEmail = patientRecord?.email?.trim();
      if (!isValidEmailAddress(patientEmail)) {
        return;
      }

      let clinicName = 'DentalCloud';
      if (patientRecord?.location_id) {
        const { data: locationRecord, error: locationError } = await supabase
          .from('locations')
          .select('name')
          .eq('id', patientRecord.location_id)
          .maybeSingle();

        if (locationError) {
          console.warn('Unable to load clinic name for patient notification:', locationError.message);
        } else if (locationRecord?.name?.trim()) {
          clinicName = locationRecord.name.trim();
        }
      }

      const resolvedPatientName = patientName || patientRecord?.name?.trim() || 'there';
      const resolvedAdminName = adminName?.trim() || 'our clinic team';
      const preview = truncateMessagePreview(message.content);
      const safePreview = escapeHtml(preview);
      const safePatientName = escapeHtml(resolvedPatientName);
      const safeAdminName = escapeHtml(resolvedAdminName);
      const safeClinicName = escapeHtml(clinicName);

      await api.email.sendManagerEmail({
        to: patientEmail!,
        fromName: emailSettings.senderName || clinicName,
        fromEmail: emailSettings.senderEmail,
        subject: `New message from ${clinicName}`,
        body: `Hi ${resolvedPatientName},\n\n${resolvedAdminName} sent you a new message in ${clinicName}.\n\n"${preview}"\n\nOpen the patient portal to read and reply.`,
        html: `
          <div style="font-family: Arial, sans-serif; background: #f8fafc; padding: 24px; color: #0f172a;">
            <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
              <div style="padding: 24px; border-bottom: 1px solid #e2e8f0; background: #eef2ff;">
                <div style="font-size: 20px; font-weight: 700;">New Message Reply</div>
                <div style="margin-top: 6px; font-size: 13px; color: #475569;">${safeClinicName}</div>
              </div>
              <div style="padding: 24px;">
                <p style="margin: 0 0 16px;">Hi ${safePatientName},</p>
                <p style="margin: 0 0 16px;">${safeAdminName} sent you a new message in your patient chat.</p>
                <div style="margin: 0 0 20px; padding: 16px; border-radius: 12px; background: #f8fafc; border: 1px solid #e2e8f0;">
                  ${safePreview}
                </div>
                <p style="margin: 0; font-size: 13px; color: #475569;">Open the patient portal to read the full message and reply.</p>
              </div>
            </div>
          </div>
        `
      });
    },
    
    // Create new conversation (admin <-> patient|doctor)
    createConversation: async (
      participantId: string,
      adminId: string,
      participantType: 'patient' | 'doctor' = 'patient',
      locationId?: string
    ): Promise<Conversation> => {
      // Perform automatic cleanup before creating new conversation
      await api.messages.performAutomaticCleanup();
      
      // Validate UUIDs
      if (!participantId || participantId === 'undefined' || !adminId || adminId === 'undefined' || adminId === 'admin-default') {
        throw new Error('Invalid participant or admin ID for conversation creation');
      }

      const supportsDoctorMessaging = await detectConversationsDoctorUserSupport();
      if (participantType === 'doctor' && !supportsDoctorMessaging) {
        throw new Error('Database update required: run database/add_doctor_admin_messaging.sql first.');
      }

      const selectClause = supportsDoctorMessaging
        ? `
          id,
          patient_id,
          doctor_user_id,
          patients(name),
          admin_id,
          admin_user:users!conversations_admin_id_fkey(username),
          last_message,
          last_message_time,
          created_at
        `
        : `
          id,
          patient_id,
          patients(name),
          admin_id,
          admin_user:users!conversations_admin_id_fkey(username),
          last_message,
          last_message_time,
          created_at
        `;

      let existingQuery = supabase
        .from('conversations')
        .select(selectClause)
        .eq('admin_id', adminId);

      if (participantType === 'doctor') {
        existingQuery = existingQuery.eq('doctor_user_id', participantId);
      } else {
        existingQuery = existingQuery.eq('patient_id', participantId);
      }

      // When locationId is provided, also filter by location to avoid returning
      // conversations from a different branch that won't show up in the filtered list.
      if (locationId) {
        existingQuery = existingQuery.eq('location_id', locationId);
      } else {
        // Fallback: also accept conversations with NULL location_id (created before branch feature)
        existingQuery = existingQuery.is('location_id', null);
      }

      const { data: existingConversation, error: existingError } = await existingQuery.maybeSingle();

      if (existingError) {
        throw new Error(existingError.message);
      }

      if (existingConversation) {
        return api.messages.mapConversationRow(existingConversation, 0);
      }

      const insertPayload: any = {
        admin_id: adminId,
        last_message: null,
        last_message_time: null
      };
      if (participantType === 'doctor') {
        insertPayload.doctor_user_id = participantId;
      } else {
        insertPayload.patient_id = participantId;
      }
      if (locationId) {
        insertPayload.location_id = locationId;
      }

      const { data: conversation, error } = await supabase
        .from('conversations')
        .insert(insertPayload)
        .select(selectClause)
        .single();
      
      if (error) throw new Error(error.message);

      return api.messages.mapConversationRow(conversation, 0);
    },
    
    // Mark messages as read
    markAsRead: async (conversationId: string, userId: string, userType: 'patient' | 'admin'): Promise<void> => {
      let updateQuery = supabase
        .from('messages')
        .update({ read: true })
        .eq('conversation_id', conversationId)
        .eq('read', false);
      
      if (userType === 'patient') {
        updateQuery = updateQuery.eq('recipient_id', userId).eq('recipient_type', 'patient');
      } else {
        updateQuery = updateQuery.eq('recipient_id', userId).eq('recipient_type', 'admin');
      }
      
      const { error } = await updateQuery;
      if (error) throw new Error(error.message);
    },
    
    // Toggle messaging feature state
    toggleMessagingFeature: (enabled: boolean): void => {
      // This is primarily handled in App.tsx state, but we provide this hook for API-level side effects if needed
      console.log(`Messaging feature ${enabled ? 'enabled' : 'disabled'}`);
    },
    
    // Remove all messages and conversations (for maintenance)
    removeAllMessages: async (): Promise<void> => {
      // Delete all messages
      const { error: msgError } = await supabase
        .from('messages')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all using always-true condition
      
      if (msgError) throw new Error(msgError.message);
      
      // Delete all conversations
      const { error: convError } = await supabase
        .from('conversations')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all
      
      if (convError) throw new Error(convError.message);
    },
    
    // Automatic cleanup function - removes messages older than 2 months
    performAutomaticCleanup: async (): Promise<void> => {
      try {
        // Check if cleanup was performed recently (within last 24 hours)
        const lastCleanup = localStorage.getItem('messaging_last_cleanup');
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        
        if (lastCleanup && (now - parseInt(lastCleanup)) < oneDay) {
          return; // Skip cleanup if performed recently
        }
        
        // Delete messages older than 2 months
        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
        
        const { error: messageError } = await supabase
          .from('messages')
          .delete()
          .lt('timestamp', twoMonthsAgo.toISOString());
        
        if (messageError) {
          console.warn('Message cleanup error:', messageError.message);
          // Continue with conversation cleanup even if message cleanup has issues
        }
        
        // Clean up conversations that have no messages and are older than 2 months
        const { data: conversations } = await supabase
          .from('conversations')
          .select('id, created_at')
          .lt('created_at', twoMonthsAgo.toISOString());
        
        if (conversations && conversations.length > 0) {
          // Check which conversations have no messages
          const conversationIds = conversations.map(conv => conv.id);
          const { data: messages } = await supabase
            .from('messages')
            .select('conversation_id')
            .in('conversation_id', conversationIds);
          
          const messageConversationIds = new Set(messages?.map(msg => msg.conversation_id) || []);
          const emptyConversations = conversations
            .filter(conv => !messageConversationIds.has(conv.id))
            .map(conv => conv.id);
          
          if (emptyConversations.length > 0) {
            const { error: convError } = await supabase
              .from('conversations')
              .delete()
              .in('id', emptyConversations);
            
            if (convError) {
              console.warn('Conversation cleanup error:', convError.message);
            }
          }
        }
        
        // Update last cleanup timestamp
        localStorage.setItem('messaging_last_cleanup', now.toString());
        
      } catch (error) {
        console.warn('Automatic cleanup failed:', error);
        // Don't throw error to prevent blocking normal operations
      }
    }
  },

  email: {
    sendManagerEmail: async (payload: { 
      to: string; 
      subject?: string; 
      body?: string; 
      html?: string;
      fromName?: string; 
      fromEmail?: string;
      replyTo?: string;
    }): Promise<{ id: string; messageId: string }> => {
      const { data, error } = await supabase.functions.invoke('send-manager-email', {
        body: payload
      });
      if (error) {
        console.error('Supabase email function error:', error);
        throw new Error(error.message || 'Failed to send email');
      }
      if (data?.error) {
        console.error('Supabase email function response error:', data.error);
        throw new Error(data.error);
      }
      const deliveryId = data?.id || data?.messageId;
      if (!deliveryId) {
        throw new Error('Email provider did not confirm delivery acceptance.');
      }
      return {
        id: deliveryId,
        messageId: deliveryId
      };
    }
  },
  scheduledTasks: {
    getAll: async (locationId?: string, adminId?: string): Promise<ScheduledTask[]> => {
      try {
        let query = supabase
          .from('scheduled_tasks')
          .select('*')
          .order('run_at', { ascending: true });

        if (locationId) {
          query = query.eq('location_id', locationId);
        }
        if (adminId) {
          query = query.eq('admin_id', adminId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn('Error fetching scheduled tasks:', err);
        return [];
      }
    },
    getDue: async (beforeIso: string, locationId?: string): Promise<ScheduledTask[]> => {
      try {
        let query = supabase
          .from('scheduled_tasks')
          .select('*')
          .eq('status', 'PENDING')
          .lte('run_at', beforeIso)
          .order('run_at', { ascending: true });

        if (locationId) {
          query = query.eq('location_id', locationId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (err) {
        console.warn('Error fetching due scheduled tasks:', err);
        return [];
      }
    },
    create: async (data: Partial<ScheduledTask>): Promise<ScheduledTask> => {
      const payload = {
        location_id: data.location_id,
        admin_id: data.admin_id || null,
        task_type: data.task_type,
        status: data.status || 'PENDING',
        run_at: data.run_at,
        payload: data.payload || {},
        last_error: data.last_error || null,
        sent_at: data.sent_at || null
      };

      const { data: result, error } = await supabase
        .from('scheduled_tasks')
        .insert(payload)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return result;
    },
    update: async (id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask> => {
      const { data: result, error } = await supabase
        .from('scheduled_tasks')
        .update(data)
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return result;
    },
    markProcessing: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('scheduled_tasks')
        .update({ status: 'PROCESSING', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'PENDING');

      if (error) throw new Error(error.message);
    },
    markCompleted: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('scheduled_tasks')
        .update({
          status: 'COMPLETED',
          sent_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw new Error(error.message);
    },
    markFailed: async (id: string, message: string): Promise<void> => {
      const { error } = await supabase
        .from('scheduled_tasks')
        .update({
          status: 'FAILED',
          last_error: message,
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw new Error(error.message);
    },
    cancel: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from('scheduled_tasks')
        .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
        .eq('id', id);

      if (error) throw new Error(error.message);
    }
  },
  assistantMemory: {
    get: async (adminId: string, locationId?: string) => {
      if (!adminId) throw new Error('Admin ID is required.');
      const query = supabase
        .from('assistant_memory')
        .select('profile')
        .eq('admin_id', adminId)
        .limit(1)
        .maybeSingle();

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data?.profile || null;
    },
    upsert: async (adminId: string, locationId: string, profile: any) => {
      if (!adminId) throw new Error('Admin ID is required.');
      const payload = {
        admin_id: adminId,
        location_id: locationId || null,
        profile,
        updated_at: new Date().toISOString()
      };
      const { error } = await supabase
        .from('assistant_memory')
        .upsert(payload, { onConflict: 'admin_id' });
      if (error) throw new Error(error.message);
    }
  }
};
