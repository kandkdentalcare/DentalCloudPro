
import React, { useState, useEffect, useLayoutEffect, Suspense, useMemo, useRef, useTransition, useCallback } from 'react';
import {
  Home,
  LayoutDashboard,
  Users,
  CreditCard, 
  Activity,
  Loader2,
  Stethoscope,
  ClipboardList,
  Calendar,
  UserCheck,
  Trash2,
  Settings,
  Shield,
  LogOut,
  Package,
  Sparkles,
  MapPin,
  Menu,
  X,
  MessageCircle,
  AlertTriangle,
  DollarSign
} from 'lucide-react';

import { Modal, Input, TimeInput, NavItem, Toast, ConfirmDialog } from './components/Shared';
import { SearchableSelect } from './components/SearchableSelect';
import { 
  Patient, 
  Appointment, 
  AppointmentRescheduleLog,
  TreatmentType, 
  ClinicalRecord,
  PaymentRecord,
  PaymentMethod,
  PaymentAllocation,
  PatientFile,
  Doctor,
  DoctorInput,
  DoctorTreatmentCommission,
  DoctorSchedule,
  DoctorScheduleInput,
  User, 
  Medicine, 
  MedicineSale,
  Location,
  LoyaltyRule, 
  LoyaltyTransaction,
  Expense,
  ScheduledTask,
  ReceiptSize,
  PatientType,
  AppointmentType,
  TreatmentChargeLine,
  PaymentReceiptSnapshot
} from './types';
import {
  DEFAULT_PATIENT_TYPE_NAME,
  DEFAULT_PATIENT_TYPE_OPTIONS,
  TREATMENT_CATEGORIES,
  DEFAULT_NORMAL_TAB_PERMISSIONS,
  DOCTOR_DASHBOARD_TABS,
  FLEXIBLE_STAFF_TABS,
  FULL_ACCESS_TAB_PERMISSIONS,
  type AppTabPermission
} from './constants';
import { api } from './services/api';
import { formatCurrency, getCurrencySymbol, Currency } from './utils/currency';
import { DOCTOR_SPECIALIZATIONS, resolveDoctorCommissionType, usesFlatVisitCommission } from './utils/doctorCommission';
import { buildFinancialReport, renderFinancialReportMarkdown } from './utils/aiReport';
import { auth } from './services/auth';
import { activeStaffPresence } from './services/activeStaffPresence';
import { getMyanmarCities, getTownshipsForCity } from './utils/myanmarCities';
import { supabase } from './services/supabase';
import { canManageMaterialCosts, resolveAllowedTabs } from './utils/permissions';
import { loadEmailSettingsAsync } from './utils/emailSettings';
import { buildAppointmentClinicalFocusNotes, parseAppointmentClinicalFocus } from './utils/appointmentClinicalFocus';
import { dataCache } from './utils/dataCache';
import type { SelectedMedicineCharge } from './components/MedicineSelectionModal';
import { formatPaymentAllocations, formatPaymentMethod, getPaymentAllocationTotal, getPaymentHeaderMethod, isSelectablePaymentMethod, normalizePaymentAllocations, normalizePaymentMethod, PAYMENT_METHOD_OPTIONS, validatePaymentAllocations } from './utils/paymentMethods';
import { buildLegacyPaymentReceiptSnapshot, buildPaymentReceiptSnapshot, getUncapturedMedicineSalesForReceipt, mergeTreatmentRecordsById, normalizePaymentReceiptSnapshot, removePatientTreatmentRecords, removeTreatmentRecordById } from './utils/paymentReceipt';
import { getSuggestedServiceFeeAmount, hasRecordedServiceFeeForVisit } from './utils/serviceFee';
import { getPaymentDedupeKey } from './utils/paymentTreatmentAllocation';
import { validateAuthoritativePaymentTreatments } from './utils/paymentTreatmentValidation';
import { toLocalDateInputValue } from './utils/patientCreationDate';
import type { AuditFilter } from './utils/auditLogExport';
import { filterAppointmentsForDoctor, resolveAppointmentQueryDoctorIds } from './utils/appointmentQueryScope';

// Lazy Load Views
const DashboardView = React.lazy(() => import('./components/DashboardView'));
const PatientsView = React.lazy(() => import('./components/PatientsView'));
const AppointmentsView = React.lazy(() => import('./components/AppointmentsView'));
const DoctorsView = React.lazy(() => import('./components/DoctorsView'));
const ClinicalView = React.lazy(() => import('./components/ClinicalView'));
const TreatmentConfigView = React.lazy(() => import('./components/TreatmentConfigView'));
const MaterialCostView = React.lazy(() => import('./components/MaterialCostView'));
const RecordsView = React.lazy(() => import('./components/RecordsView'));
const SettingsView = React.lazy(() => import('./components/SettingsView'));
const Receipt = React.lazy(() => import('./components/Receipt'));
const TreatmentSelectionModal = React.lazy(() => import('./components/TreatmentSelectionModal'));
const LoginView = React.lazy(() => import('./components/LoginView'));
const PatientDashboardView = React.lazy(() => import('./components/PatientDashboardView'));
const UsersView = React.lazy(() => import('./components/UsersView'));
const InventoryView = React.lazy(() => import('./components/InventoryView'));
const MedicineSelectionModal = React.lazy(() => import('./components/MedicineSelectionModal'));
const AIAssistantView = React.lazy(() => import('./components/AIAssistantView'));
const MessagingView = React.lazy(() => import('./components/MessagingView'));
const PatientMessagingView = React.lazy(() => import('./components/PatientMessagingView'));
const ExpensesView = React.lazy(() => import('./components/ExpensesView'));
const DoctorProfileView = React.lazy(() => import('./components/DoctorProfileView'));
const DoctorHomeView = React.lazy(() => import('./components/DoctorHomeView'));
const BranchSwitcherView = React.lazy(() => import('./components/BranchSwitcherView'));

const ALL_BRANCHES_VALUE = '__all_branches__';
const PAYMENT_RECORDS_STORAGE_KEY = 'dentalcloud_payment_records_v1';
const THEME_STORAGE_KEY = 'dentalcloud_hover_theme_v1';
const ACTIVE_BRANCH_STORAGE_KEY = 'dentalcloud_active_branch_id_v1';

type PaymentDraft = {
  treatments: ClinicalRecord[];
  amountTendered: number;
  previousBalance: number;
  currentTreatmentTotal: number;
  serviceFeeAmount: number;
  serviceFeeCategory: 'NEW' | 'RETURNING' | null;
  paymentMethod: PaymentMethod;
  splitPayment: boolean;
  allocations: PaymentAllocation[];
};

type PaymentServiceFeePreview = {
  category: 'NEW' | 'RETURNING';
  feeAmount: number;
  hasSuggestedFee: boolean;
} | null;

type AppointmentDraft = Partial<Appointment> & {
  guest_email?: string;
  guest_age?: string;
  guest_address?: string;
  guest_password?: string;
};

type HoverTheme = 'blue' | 'green' | 'yellow' | 'brown' | 'dark';

const THEME_OPTIONS: Array<{ value: HoverTheme; label: string }> = [
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'brown', label: 'Brown' },
  { value: 'dark', label: 'Dark' }
];

const isHoverTheme = (value: unknown): value is HoverTheme => {
  return value === 'blue' || value === 'green' || value === 'yellow' || value === 'brown' || value === 'dark';
};

const normalizeHexColor = (value: string): string | null => {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((char) => `${char}${char}`).join('')}`;
  }
  return null;
};

const parseCssColorToRgb = (value: string): { r: number; g: number; b: number } | null => {
  const hex = normalizeHexColor(value);
  if (hex) {
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16)
    };
  }

  const rgbMatch = value.trim().match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgbMatch) return null;

  return {
    r: Number.parseInt(rgbMatch[1], 10),
    g: Number.parseInt(rgbMatch[2], 10),
    b: Number.parseInt(rgbMatch[3], 10)
  };
};

const getContrastAwareTextColor = (backgroundColor: string): string => {
  const rgb = parseCssColorToRgb(backgroundColor);
  if (!rgb) return '#ffffff';

  const toLinear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  const luminance = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return luminance > 0.42 ? '#1f2937' : '#ffffff';
};

const mapLeadSourceToPatientType = (
  source: string | null | undefined,
  patientTypeOptions: string[]
): Patient['patient_type'] => {
  const trimmedSource = (source || '').trim();
  if (!trimmedSource) return DEFAULT_PATIENT_TYPE_NAME;

  const exactPatientType = patientTypeOptions.find(
    (patientType) => patientType.toLowerCase() === trimmedSource.toLowerCase()
  );
  if (exactPatientType) return exactPatientType;

  const normalized = trimmedSource.toLowerCase();
  if (normalized.includes('tiktok') && normalized.includes('hotline')) return 'Tiktok Hotline';
  if (normalized.includes('tiktok')) return 'Tiktok';
  if (normalized.includes('hotline')) return 'Hotline';
  if (normalized.includes('phone') || normalized.includes('call')) return 'Rec-ph call';
  return DEFAULT_PATIENT_TYPE_NAME;
};

const normalizePhoneDigits = (value: string | null | undefined): string => {
  const digits = (value || '').replace(/\D/g, '');
  return digits.length > 0 ? digits : (value || '').trim();
};

const isDuplicatePatientValidationError = (error: unknown): error is {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
} => {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 422 &&
    (error as { code?: unknown }).code === 'DUPLICATE_PATIENT'
  );
};

const createPaymentSubmissionKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `payment-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
};

const buildDefaultPatientTypeRecords = (): PatientType[] =>
  DEFAULT_PATIENT_TYPE_OPTIONS.map((name, index) => ({
    id: `default-${index + 1}`,
    name,
    sort_order: index,
    is_active: true
  }));

const toLocalISODate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const readPaymentRecords = (): PaymentRecord[] => {
  try {
    const raw = localStorage.getItem(PAYMENT_RECORDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item: any) => item && typeof item.amount === 'number' && typeof item.date === 'string')
      .map((item: any) => ({
        ...item,
        paymentMethod: normalizePaymentMethod(item.paymentMethod || item.payment_method),
        balanceBefore: Number(item.balanceBefore ?? item.balance_before ?? (Number(item.remainingBalance || item.remaining_balance || 0) + Number(item.amount || 0))),
        receiptSnapshot: normalizePaymentReceiptSnapshot(item.receiptSnapshot || item.receipt_snapshot)
      }));
  } catch (error) {
    console.warn('Failed to parse local payment records:', error);
    return [];
  }
};

const mergeLegacyPaymentRecords = (records: PaymentRecord[], locationId?: string): PaymentRecord[] => {
  const knownPaymentKeys = new Set(records.map(getPaymentDedupeKey));
  const legacyRecords = readPaymentRecords().filter(
    (record) => !knownPaymentKeys.has(getPaymentDedupeKey(record)) && (!locationId || record.location_id === locationId)
  );
  return [...records, ...legacyRecords].sort((a, b) =>
    (b.createdAt || b.date).localeCompare(a.createdAt || a.date)
  );
};

const getActiveBranchStorageKey = (userId?: string | null): string => {
  return userId ? `${ACTIVE_BRANCH_STORAGE_KEY}:${userId}` : ACTIVE_BRANCH_STORAGE_KEY;
};

const readPersistedBranchId = (userId?: string | null): string => {
  const dashboardLocation = localStorage.getItem('dashboardLocationId') || '';
  return (
    (userId ? localStorage.getItem(getActiveBranchStorageKey(userId)) : '') ||
    localStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY) ||
    localStorage.getItem('currentLocationId') ||
    (dashboardLocation === ALL_BRANCHES_VALUE ? '' : dashboardLocation) ||
    ''
  );
};

const persistActiveBranchId = (branchId: string, userId?: string | null) => {
  localStorage.setItem('currentLocationId', branchId);
  localStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, branchId);
  if (userId) {
    localStorage.setItem(getActiveBranchStorageKey(userId), branchId);
  }
};

const safeLoad = async <T,>(label: string, loader: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await loader;
  } catch (error) {
    console.warn(`${label} failed. Continuing with a safe empty fallback.`, error);
    return fallback;
  }
};

const isRecoveryFlowActive = (): boolean => {
  if (typeof window === 'undefined') return false;

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return searchParams.get('reset') === 'password' || hashParams.get('type') === 'recovery';
};

type ViewState = AppTabPermission;

const getDefaultUserFormData = (): Partial<User> => ({
  username: '',
  password: '',
  role: 'normal',
  location_id: null,
  allowed_tabs: [...DEFAULT_NORMAL_TAB_PERMISSIONS]
});

const getDefaultExpenseFormData = (): Partial<Expense> => ({
  description: '',
  amount: 0,
  category: '',
  date: new Date().toISOString().split('T')[0]
});

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<ViewState>(() => {
    // Restore last viewed page from localStorage on mount
    const savedView = localStorage.getItem('currentView');
    if (savedView) {
      return savedView as ViewState;
    }
    return 'dashboard';
  });
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isDoctor, setIsDoctor] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [allowedViews, setAllowedViews] = useState<ViewState[]>([]);
  const [currentUser, setCurrentUser] = useState<string>('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [currentLocationId, setCurrentLocationId] = useState<string>(() => readPersistedBranchId());
  const canUseSavedActiveBranch = (session: ReturnType<typeof auth.getSession>): boolean => {
    if (!session || session.role === 'patient' || session.role === 'doctor') return false;
    const sessionTabs = resolveAllowedTabs(session.role, session.allowed_tabs);
    return session.role === 'admin' || sessionTabs.includes('settings') || (
      !session.location_id && sessionTabs.includes('branch-switching')
    );
  };
  const getSessionRestrictedLocationId = (session: ReturnType<typeof auth.getSession>): string => {
    if (!session) return '';
    if (session.role === 'patient' || session.role === 'doctor') return session.location_id || '';
    return canUseSavedActiveBranch(session) ? '' : (session.location_id || '');
  };
  const getPreferredSessionBranchId = (session: ReturnType<typeof auth.getSession>): string => {
    if (!session) return readPersistedBranchId();
    const storedBranchId = canUseSavedActiveBranch(session) ? readPersistedBranchId(session.userId) : '';
    return storedBranchId || session.location_id || '';
  };
  const [hoverTheme, setHoverTheme] = useState<HoverTheme>(() => {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) as HoverTheme | null;
    if (savedTheme && THEME_OPTIONS.some(option => option.value === savedTheme)) {
      return savedTheme;
    }
    return 'blue';
  });
  
  const [isCompactScreen, setIsCompactScreen] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  ));
  
  useEffect(() => {
    const handleResize = () => {
      setIsCompactScreen(window.innerWidth < 1024);
    };
    
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', 'blue');
    document.documentElement.setAttribute('data-hover-theme', hoverTheme);
    localStorage.setItem(THEME_STORAGE_KEY, hoverTheme);
  }, [hoverTheme]);
  
  // -- Data State --
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientTypes, setPatientTypes] = useState<PatientType[]>(buildDefaultPatientTypeRecords());
  const [appointmentTypes, setAppointmentTypes] = useState<AppointmentType[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentPageAppointments, setAppointmentPageAppointments] = useState<Appointment[]>([]);
  const [appointmentPageTotal, setAppointmentPageTotal] = useState(0);
  const [appointmentPageLoading, setAppointmentPageLoading] = useState(false);
  const [appointmentPageRefreshKey, setAppointmentPageRefreshKey] = useState(0);
  const appointmentPageRequestRef = useRef(0);
  const [appointmentRescheduleLogs, setAppointmentRescheduleLogs] = useState<AppointmentRescheduleLog[]>([]);
  const [auditRecords, setAuditRecords] = useState<ClinicalRecord[]>([]);
  const [auditAppointments, setAuditAppointments] = useState<Appointment[]>([]);
  const [auditPayments, setAuditPayments] = useState<PaymentRecord[]>([]);
  const [auditRescheduleLogs, setAuditRescheduleLogs] = useState<AppointmentRescheduleLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);
  const [auditRefreshKey, setAuditRefreshKey] = useState(0);
  const auditRequestRef = useRef(0);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [treatmentHistory, setTreatmentHistory] = useState<ClinicalRecord[]>([]); 
  const [treatmentHistoryLoading, setTreatmentHistoryLoading] = useState(false);
  const [globalRecords, setGlobalRecords] = useState<ClinicalRecord[]>([]); 
  const [paymentRecords, setPaymentRecords] = useState<PaymentRecord[]>(() => readPaymentRecords());
  const [dashboardPatients, setDashboardPatients] = useState<Patient[]>([]);
  const [dashboardAppointments, setDashboardAppointments] = useState<Appointment[]>([]);
  const [dashboardRecords, setDashboardRecords] = useState<ClinicalRecord[]>([]);
  const [dashboardExpenses, setDashboardExpenses] = useState<Expense[]>([]);
  const [dashboardPayments, setDashboardPayments] = useState<PaymentRecord[]>(() => readPaymentRecords());
  const [dashboardLocationId, setDashboardLocationId] = useState<string>(() => {
    return localStorage.getItem('dashboardLocationId') || ALL_BRANCHES_VALUE;
  });
  const [assistantPatients, setAssistantPatients] = useState<Patient[]>([]);
  const [assistantAppointments, setAssistantAppointments] = useState<Appointment[]>([]);
  const [assistantDoctors, setAssistantDoctors] = useState<Doctor[]>([]);
  const [assistantTreatmentTypes, setAssistantTreatmentTypes] = useState<TreatmentType[]>([]);
  const [assistantRecords, setAssistantRecords] = useState<ClinicalRecord[]>([]);
  const [assistantMedicines, setAssistantMedicines] = useState<Medicine[]>([]);
  const [assistantExpenses, setAssistantExpenses] = useState<Expense[]>([]);
  const [assistantMedicineSales, setAssistantMedicineSales] = useState<MedicineSale[]>([]);
  const [assistantPaymentRecords, setAssistantPaymentRecords] = useState<PaymentRecord[]>(() => readPaymentRecords());
  const [treatmentTypes, setTreatmentTypes] = useState<TreatmentType[]>([]);
  const [patientFiles, setPatientFiles] = useState<PatientFile[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [topSellingMedicines, setTopSellingMedicines] = useState<{ medicine_id: string; medicine_name: string; total_quantity: number; total_revenue: number }[]>([]);
  const [loyaltyRules, setLoyaltyRules] = useState<LoyaltyRule[]>([]);
  const [loyaltyTransactions, setLoyaltyTransactions] = useState<LoyaltyTransaction[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [medicineSales, setMedicineSales] = useState<MedicineSale[]>([]);
  const [patientMedicineSales, setPatientMedicineSales] = useState<MedicineSale[]>([]);
  const [patientMedicineHistoryLoading, setPatientMedicineHistoryLoading] = useState(false);
  const [patientMedicineHistoryError, setPatientMedicineHistoryError] = useState<string | null>(null);
  const [patientPaymentRecords, setPatientPaymentRecords] = useState<PaymentRecord[]>([]);
  const [patientPaymentHistoryLoading, setPatientPaymentHistoryLoading] = useState(false);
  const [patientPaymentHistoryError, setPatientPaymentHistoryError] = useState<string | null>(null);
  const scheduledTaskProcessorRef = React.useRef<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const paymentSubmitInFlightRef = React.useRef(false);
  const paymentSubmissionKeyRef = React.useRef<string | null>(null);
  const dashboardFetchRequestRef = React.useRef(0);
  const initialDataFetchRequestRef = React.useRef(0);
  const treatmentHistoryRequestRef = React.useRef(0);
  const medicineHistoryRequestRef = React.useRef(0);
  const paymentHistoryRequestRef = React.useRef(0);
  
  // -- Selection State --
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [patientToEditFromAppointment, setPatientToEditFromAppointment] = useState<Patient | null>(null);
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
  const [selectedTeeth, setSelectedTeeth] = useState<number[]>([]);
  const [useFlatRate, setUseFlatRate] = useState(false);
  const [editingTreatmentType, setEditingTreatmentType] = useState<TreatmentType | null>(null);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);
  const [editingDoctor, setEditingDoctor] = useState<Doctor | null>(null);
  const [editingMedicine, setEditingMedicine] = useState<Medicine | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  
  // -- Modals State --
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [splitPaymentsAvailable, setSplitPaymentsAvailable] = useState(false);
  const [showPaymentCategoryModal, setShowPaymentCategoryModal] = useState(false);
  const [paymentServiceFeePreview, setPaymentServiceFeePreview] = useState<PaymentServiceFeePreview>(null);
  const [manualServiceFeeAmount, setManualServiceFeeAmount] = useState('');
  const [showPatientModal, setShowPatientModal] = useState(false);
  const [showAppointmentModal, setShowAppointmentModal] = useState(false);
  const [showTreatmentTypeModal, setShowTreatmentTypeModal] = useState(false);
  const [showDoctorModal, setShowDoctorModal] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [showTreatmentSelection, setShowTreatmentSelection] = useState(false);
  const [showReceiptPrompt, setShowReceiptPrompt] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [showMedicineModal, setShowMedicineModal] = useState(false);
  const [showMedicineSelectionModal, setShowMedicineSelectionModal] = useState(false);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [doctorTransferBlockedOpen, setDoctorTransferBlockedOpen] = useState(false);
  const [doctorTransferBlockedReasons, setDoctorTransferBlockedReasons] = useState<string[]>([]);
  const [patientDuplicateWarning, setPatientDuplicateWarning] = useState<string | null>(null);
  const [appointmentDuplicateWarning, setAppointmentDuplicateWarning] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info'; show: boolean }>({ message: '', type: 'success', show: false });
  const [userFormError, setUserFormError] = useState<string | null>(null);
  const [lastPaymentAmount, setLastPaymentAmount] = useState<number>(0);
  const [lastPaymentRecord, setLastPaymentRecord] = useState<PaymentRecord | null>(null);
  const [receiptViewerPatient, setReceiptViewerPatient] = useState<Patient | null>(null);
  const [activePaymentReceiptSnapshot, setActivePaymentReceiptSnapshot] = useState<PaymentReceiptSnapshot | null>(null);
  const [selectedTreatmentsForReceipt, setSelectedTreatmentsForReceipt] = useState<ClinicalRecord[]>([]);
  const [selectedMedicineSalesForReceipt, setSelectedMedicineSalesForReceipt] = useState<MedicineSale[]>([]);
  const [currency, setCurrency] = useState<'USD' | 'MMK'>('USD');
  const [loyaltyEnabled, setLoyaltyEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('loyalty_enabled');
    return saved === null ? true : saved === 'true';
  });
  
  const [messagingEnabled, setMessagingEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('messaging_enabled');
    return saved === null ? true : saved === 'true';
  });
  const [appName, setAppName] = useState<string>('');
  const [appLogoUrl, setAppLogoUrl] = useState<string>('');
  const [receiptInfo, setReceiptInfo] = useState<{ email: string; phone: string }>({
    email: 'info@dentflowpro.com',
    phone: '(555) 123-4567'
  });
  const [receiptHeaderTitle, setReceiptHeaderTitle] = useState<string>('');
  const [receiptSize, setReceiptSize] = useState<ReceiptSize>('A4');
  const [autoOnpPatientTypeEnabled, setAutoOnpPatientTypeEnabled] = useState(false);

  // Sync browser tab title with app name in real-time
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  useEffect(() => {
    const fallbackLogo = '/assets/WinterArcLogo.png';
    const logoUrl = appLogoUrl || fallbackLogo;
    const absoluteLogoUrl = new URL(logoUrl, window.location.origin).toString();

    const setLinkHref = (selector: string, attrs: Record<string, string>) => {
      let link = document.head.querySelector<HTMLLinkElement>(selector);
      if (!link) {
        link = document.createElement('link');
        document.head.appendChild(link);
      }

      Object.entries(attrs).forEach(([key, value]) => link!.setAttribute(key, value));
    };

    setLinkHref('link[rel="icon"]', {
      rel: 'icon',
      type: 'image/png',
      href: absoluteLogoUrl
    });
    setLinkHref('link[rel="apple-touch-icon"]', {
      rel: 'apple-touch-icon',
      href: absoluteLogoUrl
    });
    setLinkHref('link[rel="manifest"]', {
      rel: 'manifest',
      href: '/manifest.webmanifest'
    });
  }, [appLogoUrl, appName]);
  
  const handleCurrencyChange = async (newCurrency: 'USD' | 'MMK') => {
    const previousCurrency = currency;
    setCurrency(newCurrency);
    try {
      await api.appSettings.saveReceiptPreferences({ currency: newCurrency });
    } catch (error) {
      setCurrency(previousCurrency);
      throw error;
    }
  };

  const handleToggleLoyalty = (enabled: boolean) => {
    setLoyaltyEnabled(enabled);
    localStorage.setItem('loyalty_enabled', String(enabled));
  };
  
  const handleToggleMessaging = (enabled: boolean) => {
    setMessagingEnabled(enabled);
    localStorage.setItem('messaging_enabled', String(enabled));
    api.messages.toggleMessagingFeature(enabled);
  };

  const handleUpdateLoyaltyRule = async (id: string, data: Partial<LoyaltyRule>) => {
    try {
      const updated = await api.loyalty.updateRule(id, data);
      setLoyaltyRules(prev => prev.map(rule => rule.id === id ? updated : rule));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateLoyaltyRule = async (data: Partial<LoyaltyRule>) => {
    try {
      const created = await api.loyalty.createRule({ ...data, location_id: currentLocationId || data.location_id });
      setLoyaltyRules(prev => [...prev, created]);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteLoyaltyRule = async (id: string) => {
    if (!window.confirm('Delete this loyalty rule?')) return;
    try {
      await api.loyalty.deleteRule(id);
      setLoyaltyRules(prev => prev.filter(rule => rule.id !== id));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleResetAllLoyaltyPoints = async () => {
    if (!window.confirm('Reset all patient loyalty points? This cannot be undone.')) return;
    try {
      await api.loyalty.resetAllPoints(currentLocationId || undefined);
      setPatients(prev => prev.map(patient => ({ ...patient, loyalty_points: 0 })));
      setDashboardPatients(prev => prev.map(patient => ({ ...patient, loyalty_points: 0 })));
      setAssistantPatients(prev => prev.map(patient => ({ ...patient, loyalty_points: 0 })));
      if (selectedPatient) setSelectedPatient({ ...selectedPatient, loyalty_points: 0 });
      setLoyaltyTransactions([]);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSaveClinicalFeeSettings = async (
    enabled: boolean,
    newPatientAmount: number,
    returningPatientAmount: number
  ) => {
    const normalizedNewPatientAmount = Math.max(0, Number(newPatientAmount ?? 0));
    const normalizedReturningPatientAmount = Math.max(0, Number(returningPatientAmount ?? 0));
    await api.appSettings.saveClinicalFeeSettings({
      enabled,
      newPatientAmount: normalizedNewPatientAmount,
      returningPatientAmount: normalizedReturningPatientAmount
    });
    setClinicalFeeEnabled(enabled);
    setClinicalFeeNewPatientAmount(normalizedNewPatientAmount);
    setClinicalFeeReturningPatientAmount(normalizedReturningPatientAmount);
  };

  const handleUploadAppLogo = async (file: File) => {
    const logo = await api.appSettings.uploadAppLogo(file);
    setAppLogoUrl(logo.url);
  };

  const handleSaveAppName = async (name: string) => {
    await api.appSettings.saveAppName(name);
    setAppName(name.trim());
  };

  const handleDeleteAppLogo = async () => {
    await api.appSettings.deleteAppLogo();
    setAppLogoUrl('');
  };

  const handleSaveReceiptInfo = async (info: { email: string; phone: string }) => {
    await api.appSettings.saveReceiptInfo(info);
    setReceiptInfo(info);
  };

  const handleSaveReceiptHeaderTitle = async (title: string) => {
    const normalizedTitle = title.trim();
    await api.appSettings.saveReceiptPreferences({ headerTitle: normalizedTitle });
    setReceiptHeaderTitle(normalizedTitle);
  };

  const handleHoverThemeChange = async (theme: HoverTheme) => {
    setHoverTheme(theme);
    try {
      await api.appSettings.saveHoverTheme(theme);
    } catch (error) {
      console.warn('Failed to persist hover theme:', error);
    }
  };

  const handleReceiptSizeChange = async (size: ReceiptSize) => {
    const previousSize = receiptSize;
    setReceiptSize(size);
    try {
      await api.appSettings.saveReceiptPreferences({ receiptSize: size });
    } catch (error) {
      setReceiptSize(previousSize);
      throw error;
    }
  };

  const handleAutoOnpPatientTypeChange = async (enabled: boolean) => {
    const previousValue = autoOnpPatientTypeEnabled;
    setAutoOnpPatientTypeEnabled(enabled);
    try {
      await api.appSettings.saveAutoOnpPatientTypeEnabled(enabled);
      if (enabled) {
        await fetchInitialData(currentLocationId || undefined);
      }
    } catch (error) {
      setAutoOnpPatientTypeEnabled(previousValue);
      throw error;
    }
  };
  
  const handleRemoveAllMessages = async () => {
    if (window.confirm('Are you sure you want to remove ALL messages and conversations? This action cannot be undone.')) {
      try {
        await api.messages.removeAllMessages();
        alert('All messages and conversations have been removed successfully.');
        // Refresh the page or trigger a state update to reflect changes
        window.location.reload();
      } catch (error) {
        console.error('Error removing all messages:', error);
        alert('Failed to remove all messages. Please try again.');
      }
    }
  };
  const [sidebarWidth, setSidebarWidth] = useState(190);
  const [isResizing, setIsResizing] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isTabPending, startTabTransition] = useTransition();
  const [doctorActiveTab, setDoctorActiveTab] = useState<ViewState>('dashboard');
  const [recordsInitialFilter, setRecordsInitialFilter] = useState<'all' | 'appointments' | 'treatments'>('all');
  const [appointmentsInitialDateQuickFilter, setAppointmentsInitialDateQuickFilter] = useState<'all' | 'tomorrow' | 'today'>('today');
  
  // -- Form State --
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>({
    treatments: [],
    amountTendered: 0,
    previousBalance: 0,
    currentTreatmentTotal: 0,
    serviceFeeAmount: 0,
    serviceFeeCategory: null,
    paymentMethod: 'UNKNOWN',
    splitPayment: false,
    allocations: []
  });
  useEffect(() => {
    let active = true;
    api.finance.supportsSplitPayments()
      .then((supported) => { if (active) setSplitPaymentsAvailable(supported); })
      .catch(() => { if (active) setSplitPaymentsAvailable(false); });
    return () => { active = false; };
  }, []);
  const [latestTreatmentBatch, setLatestTreatmentBatch] = useState<ClinicalRecord[]>([]);
  const [newPatientData, setNewPatientData] = useState<Partial<Patient> & { password?: string }>({
      name: '',
      email: '',
      phone: '',
      medicalHistory: '',
      password: '',
      age: undefined,
      address: '',
      city: '',
      township: '',
      patient_type: DEFAULT_PATIENT_TYPE_NAME,
      location_id: ''
    });
  const [showPatientCreationDate, setShowPatientCreationDate] = useState(false);
  const [patientCreationDate, setPatientCreationDate] = useState(() => toLocalDateInputValue());
  const [clinicalFeeEnabled, setClinicalFeeEnabled] = useState(false);
  const [clinicalFeeNewPatientAmount, setClinicalFeeNewPatientAmount] = useState(0);
  const [clinicalFeeReturningPatientAmount, setClinicalFeeReturningPatientAmount] = useState(0);
  const [newAppointmentData, setNewAppointmentData] = useState<AppointmentDraft>({ date: '', time: '', type: '', status: 'Scheduled', patient_id: '', doctor_id: '', location_id: currentLocationId || '' });
  const [appointmentPatientMode, setAppointmentPatientMode] = useState<'registered' | 'lead'>('registered');
  const [convertingLeadAppointment, setConvertingLeadAppointment] = useState<Appointment | null>(null);
  const [appointmentClinicalFocus, setAppointmentClinicalFocus] = useState('');
  const [appointmentGeneralNotes, setAppointmentGeneralNotes] = useState('');
  const [appointmentRescheduleReasonPreset, setAppointmentRescheduleReasonPreset] = useState('Patient did not arrive');
  const [appointmentRescheduleReasonCustom, setAppointmentRescheduleReasonCustom] = useState('');
  const [doctorSearchQuery, setDoctorSearchQuery] = useState('');
  const [showDoctorDropdown, setShowDoctorDropdown] = useState(false);
  const doctorDropdownRef = useRef<HTMLDivElement>(null);
  
  // Service deletion confirmation state
  const [deleteServiceConfirmOpen, setDeleteServiceConfirmOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState<{id: string, name: string} | null>(null);

  const selectedPaymentTreatments = useMemo(() => paymentDraft.treatments, [paymentDraft.treatments]);
  const paymentServiceFeeAmount = Math.max(0, Number(paymentDraft.serviceFeeAmount || 0));
  const paymentOriginalAmount = Math.max(0, Number(selectedPatient?.balance || 0)) + paymentServiceFeeAmount;
  const paymentPreviousBalance = Math.max(0, Number(paymentDraft.previousBalance || 0));
  const paymentCurrentTreatmentTotal = Math.max(0, Number(paymentDraft.currentTreatmentTotal || 0));
  const paymentAmountTendered = Math.min(paymentOriginalAmount, Math.max(0, Number(paymentDraft.amountTendered || 0)));
  const paymentClearedAmount = Math.min(paymentOriginalAmount, paymentAmountTendered);
  const effectivePaymentAllocations = paymentDraft.splitPayment
    ? paymentDraft.allocations
    : normalizePaymentAllocations(null, paymentDraft.paymentMethod, paymentAmountTendered);
  const paymentAllocationError = validatePaymentAllocations(effectivePaymentAllocations, paymentAmountTendered);
  const paymentAllocatedTotal = getPaymentAllocationTotal(paymentDraft.allocations);
  const paymentServiceFeeLabel = paymentDraft.serviceFeeCategory === 'NEW'
    ? 'New patient service fee'
    : paymentDraft.serviceFeeCategory === 'RETURNING'
      ? 'Old patient service fee'
      : 'Service fee';
  const paymentPreviewServiceFeeLabel = paymentServiceFeePreview?.category === 'NEW'
    ? 'New patient service fee'
    : paymentServiceFeePreview?.category === 'RETURNING'
      ? 'Old patient service fee'
      : 'Service fee';
  const [paymentThemeColors, setPaymentThemeColors] = useState(() => ({
    primary: '#4f46e5',
    primaryHover: '#4338ca',
    onPrimary: '#ffffff'
  }));

  useLayoutEffect(() => {
    const rootStyles = window.getComputedStyle(document.documentElement);
    const primary = rootStyles.getPropertyValue('--hover-600').trim() || '#4f46e5';
    const primaryHover = rootStyles.getPropertyValue('--hover-700').trim() || primary;
    const onPrimary = getContrastAwareTextColor(primary);

    setPaymentThemeColors({
      primary,
      primaryHover,
      onPrimary
    });
  }, [hoverTheme]);

  // Filter doctors based on search query
  const filteredDoctors = doctors.filter(doctor => {
    if (!doctorSearchQuery.trim()) return true;
    const query = doctorSearchQuery.toLowerCase();
    const name = doctor.name.toLowerCase();
    const spec = doctor.specialization?.toLowerCase() || '';
    return name.startsWith(query) || spec.startsWith(query);
  });
  const [newTreatmentTypeData, setNewTreatmentTypeData] = useState<Partial<TreatmentType>>({ name: '', cost: 0, category: '' });
  const [newDoctorData, setNewDoctorData] = useState<Partial<DoctorInput>>({ name: '', email: '', phone: '', specialization: 'General', commission_type: 'percentage', password: '', commission_percentage: 0, commission_per_visit: 0, schedules: [], location_id: currentLocationId || '', location_ids: currentLocationId ? [currentLocationId] : [] });
  const [doctorCommissionRows, setDoctorCommissionRows] = useState<DoctorTreatmentCommission[]>([]);
  const [doctorCommissionAdvancedOpen, setDoctorCommissionAdvancedOpen] = useState(false);
  const [doctorCommissionLoading, setDoctorCommissionLoading] = useState(false);
  const [doctorCommissionLoadError, setDoctorCommissionLoadError] = useState('');
  const [newUserData, setNewUserData] = useState<Partial<User>>(getDefaultUserFormData());
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [newMedicineData, setNewMedicineData] = useState<Partial<Medicine>>({
    name: '',
    description: '',
    unit: 'pack',
    item_type: 'Medicine',
    price: 0,
    stock: 0,
    min_stock: 0,
    quantity_step: 1,
    category: ''
  });
  const [newExpenseData, setNewExpenseData] = useState<Partial<Expense>>(getDefaultExpenseFormData());
  const cityOptions = useMemo(
    () => getMyanmarCities().map((city) => ({ value: city, label: city })),
    []
  );
  const appointmentTypeOptions = useMemo(() => {
    const activeNames = appointmentTypes
      .filter((type) => type.is_active)
      .map((type) => (type.name || '').trim())
      .filter(Boolean);

    if (activeNames.length > 0) {
      return activeNames;
    }

    const treatmentFallback = [...new Set(treatmentTypes.map((type) => (type.name || '').trim()).filter(Boolean))];
    return treatmentFallback.sort((a, b) => a.localeCompare(b));
  }, [appointmentTypes, treatmentTypes]);
  const appointmentTypeOptionsForModal = useMemo(() => {
    const currentType = (newAppointmentData.type || '').trim();
    if (!currentType || appointmentTypeOptions.includes(currentType)) {
      return appointmentTypeOptions;
    }
    return [...appointmentTypeOptions, currentType];
  }, [appointmentTypeOptions, newAppointmentData.type]);
  const treatmentCategorySuggestions = useMemo(() => {
    const existing = treatmentTypes.map((type) => (type.category || '').trim()).filter(Boolean);
    return [...new Set([...TREATMENT_CATEGORIES, ...existing])].sort((a, b) => a.localeCompare(b));
  }, [treatmentTypes]);
  const activePatientTypeOptions = useMemo(() => {
    const activeNames = patientTypes
      .filter((type) => type.is_active)
      .map((type) => (type.name || '').trim())
      .filter(Boolean);
    return activeNames.length > 0 ? activeNames : [...DEFAULT_PATIENT_TYPE_OPTIONS];
  }, [patientTypes]);
  const patientTypeOptionsForNewPatient = useMemo(() => {
    const currentType = (newPatientData.patient_type || '').trim();
    if (!currentType || activePatientTypeOptions.includes(currentType)) {
      return activePatientTypeOptions;
    }
    return [...activePatientTypeOptions, currentType];
  }, [activePatientTypeOptions, newPatientData.patient_type]);
  const leadSourceOptionsForAppointment = useMemo(() => {
    const currentSource = (newAppointmentData.guest_source || '').trim();
    if (!currentSource || activePatientTypeOptions.includes(currentSource)) {
      return activePatientTypeOptions;
    }
    return [...activePatientTypeOptions, currentSource];
  }, [activePatientTypeOptions, newAppointmentData.guest_source]);
  const isNewPatientAgeMissing = newPatientData.age === undefined || newPatientData.age === null;
  const townshipOptionsForNewPatient = useMemo(
    () => getTownshipsForCity(newPatientData.city || '').map((township) => ({ value: township, label: township })),
    [newPatientData.city]
  );
  const branchScopedAppointmentPatients = useMemo(() => {
    const appointmentLocationId = (newAppointmentData.location_id || '').trim() || currentLocationId;
    const scopedPatients = appointmentLocationId
      ? patients.filter((patient) => patient.location_id === appointmentLocationId)
      : patients;

    return [...scopedPatients].sort((a, b) => {
      const nameCompare = (a.name || '').localeCompare(b.name || '');
      if (nameCompare !== 0) return nameCompare;
      return (a.phone || '').localeCompare(b.phone || '');
    });
  }, [patients, currentLocationId, newAppointmentData.location_id]);
  const appointmentPatientOptions = useMemo(
    () =>
      branchScopedAppointmentPatients.map((patient) => ({
        value: patient.id,
        label: patient.phone?.trim()
          ? `${patient.name} - ${patient.phone.trim()}`
          : patient.name
      })),
    [branchScopedAppointmentPatients]
  );
  const recentDoctorByPatientId = useMemo(() => {
    const latestCompletedByPatient = new Map<string, { doctorId: string; score: number }>();
    const latestAnyByPatient = new Map<string, { doctorId: string; score: number }>();

    const getAppointmentScore = (appointment: Appointment) => {
      const dateTime = new Date(`${appointment.date}T${appointment.time || '00:00'}`).getTime();
      if (Number.isFinite(dateTime)) return dateTime;
      if (appointment.created_at) {
        const createdAtTime = new Date(appointment.created_at).getTime();
        if (Number.isFinite(createdAtTime)) return createdAtTime;
      }
      return 0;
    };

    appointments.forEach((appointment) => {
      const patientId = (appointment.patient_id || '').trim();
      const doctorId = (appointment.doctor_id || '').trim();
      if (!patientId || !doctorId || appointment.status === 'Cancelled') return;

      const score = getAppointmentScore(appointment);
      const currentAny = latestAnyByPatient.get(patientId);
      if (!currentAny || score > currentAny.score) {
        latestAnyByPatient.set(patientId, { doctorId, score });
      }

      if (appointment.status === 'Completed') {
        const currentCompleted = latestCompletedByPatient.get(patientId);
        if (!currentCompleted || score > currentCompleted.score) {
          latestCompletedByPatient.set(patientId, { doctorId, score });
        }
      }
    });

    const result = new Map<string, string>();
    latestAnyByPatient.forEach((entry, patientId) => {
      result.set(patientId, entry.doctorId);
    });
    latestCompletedByPatient.forEach((entry, patientId) => {
      result.set(patientId, entry.doctorId);
    });
    return result;
  }, [appointments]);

  const applySessionState = (session: ReturnType<typeof auth.getSession>) => {
    if (!session) {
      return;
    }

    setIsAuthenticated(true);
    setIsAdmin(session.role === 'admin');
    setIsDoctor(session.role === 'doctor');
    setCurrentUser(session.username);

    if (session.role === 'patient') {
      setAllowedViews([]);
      return;
    }
    if (session.role === 'doctor') {
      setAllowedViews([...DOCTOR_DASHBOARD_TABS] as ViewState[]);
      return;
    }

    const nextAllowedViews = resolveAllowedTabs(session.role, session.allowed_tabs).filter((tab) => (
      tab !== 'branch-switching' || !session.location_id
    )) as ViewState[];
    setAllowedViews(nextAllowedViews);
  };

  const resetStaffSession = () => {
    setIsAuthenticated(false);
    setIsAdmin(false);
    setIsDoctor(false);
    setAllowedViews([]);
    setCurrentUser('');
  };

  const canAccessView = (view: ViewState): boolean => {
    return allowedViews.includes(view);
  };

  useEffect(() => {
    if (!isDoctor) return;

    if (currentView === 'finance') return;

    if (!canAccessView(currentView)) {
      setCurrentView('dashboard');
    }
  }, [isDoctor, currentView, allowedViews]);

  useEffect(() => {
    if (!isDoctor) return;

    // Preload core doctor tabs to make first navigation feel instant on mobile.
    void import('./components/DoctorHomeView');
    void import('./components/AppointmentsView');
    void import('./components/DoctorProfileView');
  }, [isDoctor]);

  useEffect(() => {
    if (!isDoctor) return;
    setDoctorActiveTab(currentView === 'finance' ? 'appointments' : currentView);
  }, [isDoctor, currentView]);

  const handleDoctorTabChange = (nextView: ViewState) => {
    if (!isDoctor) {
      setCurrentView(nextView);
      return;
    }

    setDoctorActiveTab(nextView);
    startTabTransition(() => {
      setCurrentView(nextView);
    });
  };

  const handleOpenDoctorAppointmentsForDate = (filter: 'today' | 'tomorrow') => {
    setAppointmentsInitialDateQuickFilter(filter);
    setDoctorActiveTab('appointments');
    startTabTransition(() => {
      setCurrentView('appointments');
    });
  };

  const toggleUserTabAccess = (tab: ViewState) => {
    setUserFormError(null);
    setNewUserData(prev => {
      const currentTabs = resolveAllowedTabs('normal', prev.allowed_tabs) as ViewState[];
      const nextTabs = currentTabs.includes(tab)
        ? currentTabs.filter(currentTab => currentTab !== tab)
        : [...currentTabs, tab];

      return {
        ...prev,
        allowed_tabs: nextTabs
      };
    });
  };

  const handleUserRoleChange = (role: User['role']) => {
    setUserFormError(null);
    setNewUserData(prev => ({
      ...prev,
      role,
      allowed_tabs: role === 'admin'
        ? [...FULL_ACCESS_TAB_PERMISSIONS]
        : resolveAllowedTabs('normal', prev.allowed_tabs)
    }));
  };

  const syncCurrentSessionUser = async (updatedUser: User) => {
    const session = auth.getSession();
    if (!session || session.role === 'patient' || session.userId !== updatedUser.id) {
      return;
    }

    const updatedSession = {
      ...session,
      username: updatedUser.username,
      role: updatedUser.role,
      allowed_tabs: resolveAllowedTabs(updatedUser.role, updatedUser.allowed_tabs),
      location_id: updatedUser.location_id || null
    };

    auth.setSession(updatedSession);
    applySessionState(updatedSession);

    if (updatedSession.location_id) {
      setCurrentLocationId(updatedSession.location_id);
      persistActiveBranchId(updatedSession.location_id, updatedSession.userId);
      setDashboardLocationId(updatedSession.location_id);
      localStorage.setItem('dashboardLocationId', updatedSession.location_id);
      await fetchInitialData(updatedSession.location_id);
      return;
    }

    const unrestrictedDashboardScope = updatedSession.role === 'admin'
      ? ALL_BRANCHES_VALUE
      : currentLocationId || dashboardLocationId || locations[0]?.id || '';

    if (unrestrictedDashboardScope) {
      setDashboardLocationId(unrestrictedDashboardScope);
      localStorage.setItem('dashboardLocationId', unrestrictedDashboardScope);
    }

    await fetchInitialData(currentLocationId || undefined);
  };

  // Check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      let session = auth.getSession();
      if (session) {
        if (session.role !== 'patient') {
          try {
            session = await auth.refreshStaffSession();
          } catch (refreshError) {
            console.warn('Unable to refresh staff permissions. Using the cached session for now.', refreshError);
          }
        }

        if (!session) {
          resetStaffSession();
          return;
        }

        applySessionState(session);
        const preferredBranchId = getPreferredSessionBranchId(session);
        // Initialize default admin and fetch data
        await auth.initializeDefaultAdmin();
        fetchInitialData(preferredBranchId || undefined);
        fetchUsers();
        return;
      }

      const restoredSession = await auth.restoreSupabaseSession();
      if (restoredSession) {
        applySessionState(restoredSession);
        const preferredBranchId = getPreferredSessionBranchId(restoredSession);

        if (restoredSession.role !== 'patient') {
          fetchInitialData(preferredBranchId || undefined);
          fetchUsers();
        }
        return;
      }

      resetStaffSession();
      // Still initialize default admin for first-time setup
      auth.initializeDefaultAdmin();
    };
    
    checkAuth().catch(err => {
      console.warn('Authentication bootstrap failed:', err);
      resetStaffSession();
    });
    
  }, []);

  useEffect(() => {
    if (!isAuthenticated || auth.isPatient()) return;

    let syncInProgress = false;
    const refreshPermissions = async () => {
      if (syncInProgress) return;
      syncInProgress = true;
      const previousSession = auth.getSession();

      try {
        const refreshedSession = await auth.refreshStaffSession();
        if (!refreshedSession) {
          resetStaffSession();
          setCurrentView('dashboard');
          return;
        }

        applySessionState(refreshedSession);
        if (previousSession?.location_id !== refreshedSession.location_id) {
          const preferredBranchId = getPreferredSessionBranchId(refreshedSession);
          await fetchInitialData(preferredBranchId || undefined);
        }
      } catch (refreshError) {
        console.warn('Unable to refresh staff permissions. The current session remains active.', refreshError);
      } finally {
        syncInProgress = false;
      }
    };

    const interval = window.setInterval(() => {
      void refreshPermissions();
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [isAuthenticated]);

  useEffect(() => {
    let mounted = true;
    api.appSettings.getClinicalFeeSettings()
      .then((settings) => {
        if (!mounted) return;
        setClinicalFeeEnabled(settings.enabled);
        setClinicalFeeNewPatientAmount(settings.newPatientAmount);
        setClinicalFeeReturningPatientAmount(settings.returningPatientAmount);
      })
      .catch((err) => {
        console.warn('Failed to load clinical fee settings:', err);
      });

    api.appSettings.getAppName()
      .then((name) => {
        if (!mounted) return;
        setAppName(name);
      })
      .catch((err) => {
        console.warn('Failed to load app name:', err);
      });

    api.appSettings.getReceiptInfo()
      .then((info) => {
        if (!mounted) return;
        setReceiptInfo(info);
      })
      .catch((err) => {
        console.warn('Failed to load receipt info:', err);
      });

    api.appSettings.getReceiptPreferences()
      .then((preferences) => {
        if (!mounted || !preferences) return;
        setReceiptHeaderTitle(preferences.headerTitle);
        setCurrency(preferences.currency);
        setReceiptSize(preferences.receiptSize);
      })
      .catch((err) => {
        console.warn('Failed to load shared receipt preferences:', err);
      });

    api.appSettings.getAppLogo()
      .then((logo) => {
        if (!mounted) return;
        setAppLogoUrl(logo?.url || '');
      })
      .catch((err) => {
        console.warn('Failed to load app logo:', err);
      });

    api.appSettings.getAutoOnpPatientTypeEnabled()
      .then((enabled) => {
        if (!mounted) return;
        setAutoOnpPatientTypeEnabled(enabled);
      })
      .catch((err) => {
        console.warn('Failed to load auto ONP patient type setting:', err);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    let mounted = true;

    const refreshSharedAppSettings = async () => {
      try {
        const [theme, preferences, clinicalFeeSettings, autoOnpEnabled] = await Promise.all([
          api.appSettings.getHoverTheme(),
          api.appSettings.getReceiptPreferences(),
          api.appSettings.getClinicalFeeSettings(),
          api.appSettings.getAutoOnpPatientTypeEnabled()
        ]);
        if (mounted && theme) setHoverTheme(theme);
        if (mounted && preferences) {
          setReceiptHeaderTitle(preferences.headerTitle);
          setCurrency(preferences.currency);
          setReceiptSize(preferences.receiptSize);
        }
        if (mounted) {
          setClinicalFeeEnabled(clinicalFeeSettings.enabled);
          setClinicalFeeNewPatientAmount(clinicalFeeSettings.newPatientAmount);
          setClinicalFeeReturningPatientAmount(clinicalFeeSettings.returningPatientAmount);
          setAutoOnpPatientTypeEnabled(autoOnpEnabled);
        }
      } catch (error) {
        console.warn('Failed to refresh shared app settings:', error);
      }
    };

    refreshSharedAppSettings();

    const settingsChannel = supabase
      .channel(`app-settings-shared-preferences-${Date.now()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_settings' },
        (payload) => {
          const row = payload.new as {
            hover_theme?: unknown;
            receipt_header_title?: unknown;
            currency_unit?: unknown;
            receipt_size?: unknown;
            clinical_fee_enabled?: unknown;
            clinical_fee_amount?: unknown;
            clinical_fee_new_patient_amount?: unknown;
            clinical_fee_returning_patient_amount?: unknown;
            auto_onp_patient_type_enabled?: unknown;
          } | null;
          const nextTheme = row?.hover_theme;
          if (isHoverTheme(nextTheme)) {
            setHoverTheme(nextTheme);
          }
          if (typeof row?.receipt_header_title === 'string' || row?.receipt_header_title === null) {
            setReceiptHeaderTitle(typeof row.receipt_header_title === 'string' ? row.receipt_header_title.trim() : '');
          }
          if (row?.currency_unit === 'USD' || row?.currency_unit === 'MMK') {
            setCurrency(row.currency_unit);
          }
          if (row?.receipt_size === 'A4' || row?.receipt_size === 'THERMAL_55MM' || row?.receipt_size === 'THERMAL_80MM') {
            setReceiptSize(row.receipt_size);
          }
          if (typeof row?.clinical_fee_enabled === 'boolean') {
            setClinicalFeeEnabled(row.clinical_fee_enabled);
          }
          const nextNewPatientAmount = Number(
            row?.clinical_fee_new_patient_amount ?? row?.clinical_fee_amount
          );
          if (Number.isFinite(nextNewPatientAmount)) {
            setClinicalFeeNewPatientAmount(Math.max(0, nextNewPatientAmount));
          }
          const nextReturningPatientAmount = Number(
            row?.clinical_fee_returning_patient_amount ?? row?.clinical_fee_amount
          );
          if (Number.isFinite(nextReturningPatientAmount)) {
            setClinicalFeeReturningPatientAmount(Math.max(0, nextReturningPatientAmount));
          }
          if (typeof row?.auto_onp_patient_type_enabled === 'boolean') {
            setAutoOnpPatientTypeEnabled(row.auto_onp_patient_type_enabled);
          }
        }
      )
      .subscribe();

    const fallbackPoll = window.setInterval(refreshSharedAppSettings, 10000);

    return () => {
      mounted = false;
      window.clearInterval(fallbackPoll);
      supabase.removeChannel(settingsChannel);
    };
  }, [isAuthenticated]);

  const handleLoginSuccess = () => {
    const session = auth.getSession();
    if (session) {
      applySessionState(session);

      const canSeeAllBranches = session.role === 'admin' && !session.location_id;
      const preferredBranchId = getPreferredSessionBranchId(session);
      const initialDashboardScope = canSeeAllBranches
        ? ALL_BRANCHES_VALUE
        : (preferredBranchId || currentLocationId || '');
      setDashboardLocationId(initialDashboardScope);
      localStorage.setItem('dashboardLocationId', initialDashboardScope);
      
      // If user is restricted to a location, set it
      if (session.location_id) {
        setCurrentLocationId(session.location_id);
        persistActiveBranchId(session.location_id, session.userId);
      }
      
      // For patients, don't fetch admin data
      if (session.role !== 'patient') {
        fetchInitialData(getPreferredSessionBranchId(session) || undefined);
        fetchUsers();
      }
    }
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);

    try {
      await auth.logout();
    } catch (error: any) {
      setToast({
        show: true,
        message: error?.message || 'Failed to log out cleanly.',
        type: 'error'
      });
      setIsLoggingOut(false);
      return;
    }

    treatmentHistoryRequestRef.current += 1;
    medicineHistoryRequestRef.current += 1;
    paymentHistoryRequestRef.current += 1;
    resetStaffSession();
    setCurrentView('dashboard');
    localStorage.removeItem('currentView');
    // Reset all data state
    setPatients([]);
    setAppointments([]);
    setAppointmentRescheduleLogs([]);
    setDoctors([]);
    setTreatmentHistory([]);
    setTreatmentHistoryLoading(false);
    setGlobalRecords([]);
    setPaymentRecords([]);
    setTreatmentTypes([]);
    setPatientFiles([]);
    setUsers([]);
    setMedicines([]);
    setLoyaltyRules([]);
    setLoyaltyTransactions([]);
    setExpenses([]);
    setMedicineSales([]);
    setPatientMedicineSales([]);
    setPatientMedicineHistoryLoading(false);
    setPatientMedicineHistoryError(null);
    setPatientPaymentRecords([]);
    setPatientPaymentHistoryLoading(false);
    setPatientPaymentHistoryError(null);
    setDashboardPatients([]);
    setDashboardAppointments([]);
    setDashboardRecords([]);
    setDashboardLocationId(ALL_BRANCHES_VALUE);
    setDashboardPayments([]);
    setAssistantPatients([]);
    setAssistantAppointments([]);
    setAssistantDoctors([]);
    setAssistantTreatmentTypes([]);
    setAssistantRecords([]);
    setAssistantMedicines([]);
    setAssistantExpenses([]);
    setAssistantMedicineSales([]);
    setAssistantPaymentRecords([]);
    localStorage.removeItem('dashboardLocationId');
    setIsLoggingOut(false);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsResizing(true);
    e.preventDefault();
  };

  const handleMouseMove = React.useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    const newWidth = e.clientX;
    if (newWidth >= 190 && newWidth <= 400) {
      setSidebarWidth(newWidth);
    }
  }, [isResizing]);

  const handleMouseUp = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const fetchUsers = async () => {
    if (!isAdmin) return;
    try {
      const usersData = await api.users.getAll(currentLocationId || undefined);
      setUsers(usersData);
    } catch (err: any) {
      console.warn('Error fetching users:', err);
    }
  };

  const fetchDashboardData = async (
    scopeLocationId?: string,
    knownLocations?: Location[],
    // Preloaded data from fetchInitialData to avoid redundant API calls.
    preloaded?: { patients?: Patient[]; appointments?: Appointment[] | Promise<Appointment[]>; records?: ClinicalRecord[]; expenses?: Expense[] }
  ) => {
    const requestId = ++dashboardFetchRequestRef.current;
    const session = auth.getSession();
    const restrictedLocationId = getSessionRestrictedLocationId(session);
    const availableLocations = knownLocations || locations;
    const canUseAllBranchesScope = !restrictedLocationId && scopeLocationId === ALL_BRANCHES_VALUE;
    const requestedScope = canUseAllBranchesScope
      ? ALL_BRANCHES_VALUE
      : restrictedLocationId || scopeLocationId || currentLocationId || availableLocations[0]?.id || '';
    const hasMatchingLocation = availableLocations.some(loc => loc.id === requestedScope);
    const sanitizedScope = canUseAllBranchesScope
      ? ALL_BRANCHES_VALUE
      : restrictedLocationId || (hasMatchingLocation ? requestedScope : (availableLocations[0]?.id || requestedScope));
    const queryLocationId = sanitizedScope === ALL_BRANCHES_VALUE ? undefined : (sanitizedScope || undefined);
    // Use preloaded data when available; fetch missing dashboard datasets in parallel.
    const [patData, aptData, recordsData, expenseData, scopedPayments] = await Promise.all([
      preloaded?.patients ? Promise.resolve(preloaded.patients) : safeLoad('Dashboard patients', api.patients.getAll(queryLocationId), []),
      preloaded?.appointments ? Promise.resolve(preloaded.appointments) : safeLoad('Dashboard appointments', api.appointments.getAll(queryLocationId), []),
      preloaded?.records ? Promise.resolve(preloaded.records) : safeLoad('Dashboard treatment records', api.treatments.getAllRecords(queryLocationId), []),
      preloaded?.expenses ? Promise.resolve(preloaded.expenses) : safeLoad('Dashboard expenses', api.expenses.getAll(queryLocationId), []),
      safeLoad('Dashboard payments', api.finance.getPayments(queryLocationId), [])
    ]);

    if (requestId !== dashboardFetchRequestRef.current) {
      return;
    }

    setDashboardPatients(patData);
    setDashboardAppointments(aptData);
    setDashboardRecords(recordsData);
    setDashboardExpenses(expenseData);
    setDashboardPayments(mergeLegacyPaymentRecords(scopedPayments, queryLocationId));
    setDashboardLocationId(sanitizedScope);
    localStorage.setItem('dashboardLocationId', sanitizedScope);
  };

  const fetchAssistantData = async () => {
    const session = auth.getSession();
    const restrictedLocationId = getSessionRestrictedLocationId(session);
    const queryLocationId = restrictedLocationId || currentLocationId || undefined;
    const assistantLocationId = queryLocationId;

    const [patData, aptData, docData, typeData, recordsData, medData, expenseData, salesData, paymentData] = await Promise.all([
      safeLoad('Assistant patients', api.patients.getAll(assistantLocationId), []),
      safeLoad('Assistant appointments', api.appointments.getAll(assistantLocationId), []),
      safeLoad('Assistant doctors', api.doctors.getAll(assistantLocationId), []),
      safeLoad('Assistant treatment types', api.treatments.getTypes(assistantLocationId), []),
      safeLoad('Assistant treatment records', api.treatments.getAllRecords(assistantLocationId), []),
      safeLoad('Assistant medicines', api.medicines.getAll(assistantLocationId), []),
      safeLoad('Assistant expenses', api.expenses.getAll(assistantLocationId), []),
      safeLoad('Assistant medicine sales', api.medicines.getSales(assistantLocationId), []),
      safeLoad('Assistant payments', api.finance.getPayments(assistantLocationId), [])
    ]);

    setAssistantPatients(patData);
    setAssistantAppointments(aptData);
    setAssistantDoctors(docData);
    setAssistantTreatmentTypes(typeData);
    setAssistantRecords(recordsData);
    setAssistantMedicines(medData);
    setAssistantExpenses(expenseData);
    setAssistantMedicineSales(salesData);
    setAssistantPaymentRecords(mergeLegacyPaymentRecords(paymentData, assistantLocationId));
  };

  const loadAppointmentPage = useCallback(async (query: {
    dateQuickFilter: 'all' | 'tomorrow' | 'today' | 'custom';
    date: string;
    search: string;
    doctor: string;
    treatment: string;
    page: number;
    viewMode: 'current' | 'calendar';
    calendarDateFrom?: string;
    calendarDateTo?: string;
  }) => {
    const locationId = currentLocationId || undefined;
    if (!locationId) return;
    const session = auth.getSession();

    const now = new Date();
    const toLocalISODate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = query.viewMode === 'calendar'
      ? undefined
      : query.dateQuickFilter === 'today'
      ? toLocalISODate(now)
      : query.dateQuickFilter === 'tomorrow'
        ? toLocalISODate(tomorrow)
        : query.dateQuickFilter === 'custom'
          ? query.date
          : undefined;
    const doctorTerm = query.doctor.trim().toLowerCase();
    const requestedDoctorIds = doctorTerm
      ? doctors.filter((doctor) => doctor.id === query.doctor || doctor.name.toLowerCase().includes(doctorTerm)).map((doctor) => doctor.id)
      : undefined;
    const doctorIds = resolveAppointmentQueryDoctorIds({
      role: session?.role,
      doctorId: session?.doctor_id,
      requestedDoctorIds
    });
    if ((session?.role === 'doctor' && !doctorIds?.length) || (doctorTerm && !requestedDoctorIds?.length)) {
      setAppointmentPageAppointments([]);
      setAppointmentPageTotal(0);
      setAppointmentPageLoading(false);
      return;
    }
    const requestId = ++appointmentPageRequestRef.current;
    setAppointmentPageLoading(true);
    try {
      const result = await api.appointments.list(locationId, {
        date,
        dateFrom: query.viewMode === 'calendar' ? query.calendarDateFrom : undefined,
        dateTo: query.viewMode === 'calendar' ? query.calendarDateTo : undefined,
        page: query.viewMode === 'calendar' ? 1 : query.page,
        pageSize: query.viewMode === 'calendar' ? 1000 : 100,
        search: query.search,
        doctorIds,
        treatment: query.treatment
      });
      if (requestId !== appointmentPageRequestRef.current) return;
      setAppointmentPageAppointments(filterAppointmentsForDoctor(result.appointments, session?.role, session?.doctor_id));
      setAppointmentPageTotal(result.total);
    } catch (err) {
      if (requestId !== appointmentPageRequestRef.current) return;
      console.warn('Error fetching appointment page:', err);
      setAppointmentPageAppointments([]);
      setAppointmentPageTotal(0);
    } finally {
      if (requestId === appointmentPageRequestRef.current) setAppointmentPageLoading(false);
    }
  }, [currentLocationId, doctors, appointmentPageRefreshKey]);

  const loadAuditLog = useCallback(async (query: {
    dateFrom: string;
    dateTo: string;
    auditFilter: AuditFilter;
  }) => {
    const locationId = currentLocationId || undefined;
    const requestId = ++auditRequestRef.current;
    if (!locationId) {
      setAuditRecords([]);
      setAuditAppointments([]);
      setAuditPayments([]);
      setAuditRescheduleLogs([]);
      setAuditLoadError(null);
      setAuditLoading(false);
      return;
    }

    const session = auth.getSession();
    const doctorId = session?.role === 'doctor' ? session.doctor_id || undefined : undefined;
    const includeAppointments = query.auditFilter === 'all' || query.auditFilter === 'appointments';
    const includePayments = !doctorId && (query.auditFilter === 'all' || query.auditFilter === 'payments');
    const includeReschedules = !doctorId && (query.auditFilter === 'all' || query.auditFilter === 'reschedules');
    // Payment commission is calculated from treatment ownership/rates and its
    // immutable ledger entries, so load the related treatment rows even when
    // the Payments tab is the only visible audit filter.
    const includeTreatments = query.auditFilter === 'all' || query.auditFilter === 'treatments' || includePayments;

    setAuditLoading(true);
    setAuditLoadError(null);
    try {
      const [records, scopedAppointments, payments, rescheduleLogs] = await Promise.all([
        includeTreatments
          ? api.treatments.getAllRecords(locationId, {
              limit: null,
              dateFrom: query.dateFrom,
              dateTo: query.dateTo,
              doctorId,
              includeCommissionEntries: includePayments,
              throwOnError: true
            })
          : Promise.resolve([]),
        includeAppointments
          ? api.appointments.getAll(locationId, {
              dateFrom: query.dateFrom,
              dateTo: query.dateTo,
              doctorId,
              throwOnError: true
            })
          : Promise.resolve([]),
        includePayments
          ? api.finance.getPayments(locationId, { dateFrom: query.dateFrom, dateTo: query.dateTo })
          : Promise.resolve([]),
        includeReschedules
          ? api.appointmentRescheduleLogs.getAll(locationId, {
              dateFrom: query.dateFrom,
              dateTo: query.dateTo,
              throwOnError: true
            })
          : Promise.resolve([])
      ]);
      if (requestId !== auditRequestRef.current) return;

      const scopedPayments = mergeLegacyPaymentRecords(payments, locationId).filter((payment) => {
        const paymentDate = payment.date || payment.createdAt?.slice(0, 10) || '';
        return paymentDate >= query.dateFrom && paymentDate <= query.dateTo;
      });
      setAuditRecords(records);
      setAuditAppointments(scopedAppointments);
      setAuditPayments(scopedPayments);
      setAuditRescheduleLogs(rescheduleLogs);
    } catch (err: any) {
      if (requestId !== auditRequestRef.current) return;
      console.warn('Error fetching audit log range:', err);
      setAuditRecords([]);
      setAuditAppointments([]);
      setAuditPayments([]);
      setAuditRescheduleLogs([]);
      setAuditLoadError(err?.message || 'Audit log data could not be loaded. Please retry.');
    } finally {
      if (requestId === auditRequestRef.current) setAuditLoading(false);
    }
  }, [currentLocationId, auditRefreshKey]);

  const fetchInitialData = async (
    overrideLocationId?: string,
    options: { deferBranchCommit?: boolean; throwOnError?: boolean } = {}
  ) => {
    const requestId = ++initialDataFetchRequestRef.current;
    try {
      setLoading(true);
      setError(null);
      
      const [locData, patientTypeData, appointmentTypeData] = await Promise.all([
        api.locations.getAll(),
        safeLoad('Patient type options', api.patientTypes.getAll(), []),
        safeLoad('Appointment type options', api.appointmentTypes.getAll(), [])
      ]);
      if (requestId !== initialDataFetchRequestRef.current) return;

      setLocations(locData);
      setPatientTypes(patientTypeData);
      setAppointmentTypes(appointmentTypeData);
      const session = auth.getSession();
      const restrictedLocationId = getSessionRestrictedLocationId(session);
      const storedLocationId = canUseSavedActiveBranch(session) ? readPersistedBranchId(session?.userId) : '';

      if (!options.deferBranchCommit && restrictedLocationId && currentLocationId !== restrictedLocationId) {
        setCurrentLocationId(restrictedLocationId);
        persistActiveBranchId(restrictedLocationId, session?.userId);
      }
      
      // Resolve branch in stable order: locked session branch > explicit override > persisted storage > current state.
      let locId = restrictedLocationId || overrideLocationId || storedLocationId || currentLocationId;
      if (!restrictedLocationId && locId && !locData.some((loc) => loc.id === locId)) {
        locId = '';
      }

      // If no location selected but locations exist, select first one
      if (!locId && locData.length > 0) {
        locId = locData[0].id;
        if (!options.deferBranchCommit) {
          setCurrentLocationId(locId);
          persistActiveBranchId(locId, session?.userId);
        }
      }
      
      // If still no location, try to create a default one
      if (!locId) {
        try {
          const defaultLocation = await api.locations.create({
            name: 'Main Clinic',
            address: 'Default Address',
            phone: '000-000-0000'
          });
          locId = defaultLocation.id;
          if (!options.deferBranchCommit) {
            setCurrentLocationId(locId);
            persistActiveBranchId(locId, session?.userId);
          }
          setLocations([defaultLocation]);
        } catch (createError) {
          console.error('Failed to create default location:', createError);
        }
      }

      // Keep branch selection sticky across refreshes:
      // whenever a location is resolved (stored/override/restricted/default), sync state + storage.
      if (!options.deferBranchCommit && locId && currentLocationId !== locId) {
        setCurrentLocationId(locId);
        persistActiveBranchId(locId, session?.userId);
      }
      
      // Only fetch data if we have a valid location
      if (locId) {
        // � Critical data: what the main views need immediately �
        const sessionDoctorId = session?.role === 'doctor' ? session.doctor_id : null;
        const allDoctorsForSession = sessionDoctorId ? await safeLoad('Doctor session branch lookup', api.doctors.getAll(), []) : [];
        const activeSessionDoctor = sessionDoctorId
          ? allDoctorsForSession.find((doctor) => doctor.id === sessionDoctorId) || null
          : null;
        const doctorLocationIds = activeSessionDoctor
          ? Array.from(new Set([...(activeSessionDoctor.location_ids || []), activeSessionDoctor.location_id].filter(Boolean)))
          : [];
        const doctorQueryLocationIds = sessionDoctorId && doctorLocationIds.length > 0 ? doctorLocationIds : [locId];
        const isDoctorMultiBranchSession = !!sessionDoctorId && doctorQueryLocationIds.length > 1;
        const appointmentsPromise = isDoctorMultiBranchSession
          ? Promise.all(doctorQueryLocationIds.map((locationId) => safeLoad(`Appointments for doctor branch ${locationId}`, api.appointments.getAll(locationId), []))).then((groups) => groups.flat())
          : api.appointments.getAll(locId);
        const [patData, docData, typeData, recordsData, medData, paymentsData, rescheduleLogsData] = await Promise.all([
          isDoctorMultiBranchSession
            ? Promise.all(doctorQueryLocationIds.map((locationId) => safeLoad(`Patients for doctor branch ${locationId}`, api.patients.getAll(locationId), []))).then((groups) => groups.flat())
            : api.patients.getAll(locId),
          activeSessionDoctor ? Promise.resolve([activeSessionDoctor]) : safeLoad('Doctors', api.doctors.getAll(locId), []),
          safeLoad('Treatment types', api.treatments.getTypes(locId), []),
          isDoctorMultiBranchSession
            ? Promise.all(doctorQueryLocationIds.map((locationId) => safeLoad(`Treatment records for doctor branch ${locationId}`, api.treatments.getAllRecords(locationId, { limit: null }), []))).then((groups) => groups.flat())
            : api.treatments.getAllRecords(locId, { limit: null }),
          safeLoad('Medicines', api.medicines.getAll(locId), []),
          safeLoad('Payments', api.finance.getPayments(locId), []),
          safeLoad('Appointment reschedule logs', api.appointmentRescheduleLogs.getAll(locId), [])
        ]);
        if (requestId !== initialDataFetchRequestRef.current) return;

        const isDoctorSession = session?.role === 'doctor' && !!session?.doctor_id;
        const doctorAppointmentsPromise = appointmentsPromise.then((aptData) => isDoctorSession
          ? aptData.filter((appointment) => appointment.doctor_id === session.doctor_id)
          : aptData);
        const doctorRecords = isDoctorSession
          ? recordsData.filter((record) => record.doctor_id === session.doctor_id)
          : recordsData;
        const doctorPatientIds = new Set<string>([
          ...doctorRecords.map((record) => record.patient_id)
        ]);
        const scopedPatients = isDoctorSession
          ? patData.filter((patient) => doctorPatientIds.has(patient.id))
          : patData;

        const scopedDoctors = isDoctorSession
          ? docData.filter((doctor) => doctor.id === session?.doctor_id)
          : docData;

        setPatients(scopedPatients);
        setAppointments([]);
        setDoctors(scopedDoctors);
        setTreatmentTypes(typeData);
        setGlobalRecords(doctorRecords);
        setPaymentRecords(isDoctorSession ? [] : mergeLegacyPaymentRecords(paymentsData, locId));
        setAppointmentRescheduleLogs(isDoctorSession ? [] : rescheduleLogsData);
        setMedicines(medData);
        setLoyaltyRules([]);
        setExpenses([]);
            setMedicineSales([]);

        // Unhide the main UI as soon as the critical data is in state.
        if (requestId === initialDataFetchRequestRef.current) {
          setLoading(false);
        }

        void doctorAppointmentsPromise.then((doctorAppointments) => {
          if (requestId !== initialDataFetchRequestRef.current) return;
          setAppointments(doctorAppointments);
          if (isDoctorSession) {
            const appointmentPatientIds = new Set(doctorAppointments.map((appointment) => appointment.patient_id).filter((patientId): patientId is string => !!patientId));
            setPatients(patData.filter((patient) => doctorPatientIds.has(patient.id) || appointmentPatientIds.has(patient.id)));
          }
        });

        // � Deferred data: load in background so the UI is interactive faster �
        void (async () => {
          try {
            const [loyaltyData, expenseData, salesData] = await Promise.all([
              safeLoad('Deferred loyalty rules', api.loyalty.getRules(locId), []),
              safeLoad('Deferred expenses', api.expenses.getAll(locId), []),
              safeLoad('Deferred medicine sales', api.medicines.getSales(locId), []),
            ]);
            if (requestId !== initialDataFetchRequestRef.current) return;

            setLoyaltyRules(loyaltyData);
            setExpenses(expenseData);
            setMedicineSales(salesData);
          } catch (deferredErr) {
            console.warn('Deferred data fetch failed:', deferredErr);
          }
        })();

        if (requestId === initialDataFetchRequestRef.current) {
          await fetchDashboardData(locId, locData, {
            patients: scopedPatients,
            appointments: doctorAppointmentsPromise,
            records: doctorRecords,
          });
        }
      }

      if (requestId !== initialDataFetchRequestRef.current) return;
    } catch (err: any) {
      if (requestId !== initialDataFetchRequestRef.current) return;
      console.error('Error fetching initial data:', err);
      if (options.throwOnError) {
        throw err;
      }
      setError(err.message || "Failed to connect to database. Please check your network.");
    } finally {
      if (requestId === initialDataFetchRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const handleLocationChange = async (locId: string) => {
    const session = auth.getSession();
    treatmentHistoryRequestRef.current += 1;
    medicineHistoryRequestRef.current += 1;
    paymentHistoryRequestRef.current += 1;
    setLatestTreatmentBatch([]);
    setPaymentDraft({ treatments: [], amountTendered: 0, previousBalance: 0, currentTreatmentTotal: 0, serviceFeeAmount: 0, serviceFeeCategory: null, paymentMethod: 'UNKNOWN', splitPayment: false, allocations: [] });
    setSelectedPatient(null);
    setTreatmentHistoryLoading(false);
    setPatientMedicineSales([]);
    setPatientMedicineHistoryLoading(false);
    setPatientMedicineHistoryError(null);
    setPatientPaymentRecords([]);
    setPatientPaymentHistoryLoading(false);
    setPatientPaymentHistoryError(null);
    setShowPatientModal(false);
    setShowAppointmentModal(false);
    setShowPaymentModal(false);
    setShowReceipt(false);
    setShowTreatmentSelection(false);
    setShowReceiptPrompt(false);
    setShowTreatmentTypeModal(false);
    setShowDoctorModal(false);
    setShowUserModal(false);
    setShowMedicineModal(false);
    setShowMedicineSelectionModal(false);
    setShowExpenseModal(false);
    setEditingAppointment(null);
    setEditingDoctor(null);
    setEditingMedicine(null);
    setEditingExpense(null);
    setEditingTreatmentType(null);
    setConvertingLeadAppointment(null);
    dataCache.clear(); // Fresh branch = fresh data
    await fetchInitialData(locId, { deferBranchCommit: true, throwOnError: true });

    setCurrentLocationId(locId);
    persistActiveBranchId(locId, session?.userId);
    setDashboardLocationId(locId);
    localStorage.setItem('dashboardLocationId', locId);

    if (session) {
      try {
        await activeStaffPresence.markActive(session, locId);
      } catch (presenceError) {
        console.warn('Branch changed, but active staff presence could not be refreshed.', presenceError);
      }
    }
  };

  const handleDashboardLocationChange = async (locId: string) => {
    try {
      setLoading(true);
      setError(null);
      setDashboardLocationId(locId);
      localStorage.setItem('dashboardLocationId', locId);
      setDashboardPatients([]);
      setDashboardAppointments([]);
      setDashboardRecords([]);
      setDashboardExpenses([]);
      await fetchDashboardData(locId);
    } catch (err: any) {
      console.error('Error fetching dashboard data:', err);
      setError(err.message || 'Failed to update dashboard reporting.');
    } finally {
      setLoading(false);
    }
  };

  const refreshAssistantData = async () => {
    await fetchInitialData(currentLocationId || undefined);
    await fetchAssistantData();
    if (isAdmin) {
      await fetchUsers();
    }
  };

  const buildDailyReportEmailBody = async (task: ScheduledTask) => {
    const locationId = task.location_id || currentLocationId || undefined;
    const [reportTreatments, reportExpenses, reportMedicines, reportMedicineSales, scopedPayments] = await Promise.all([
      safeLoad('Daily report treatment records', api.treatments.getAllRecords(locationId), []),
      safeLoad('Daily report expenses', api.expenses.getAll(locationId), []),
      safeLoad('Daily report medicines', api.medicines.getAll(locationId), []),
      safeLoad('Daily report medicine sales', api.medicines.getSales(locationId), []),
      safeLoad('Daily report payments', api.finance.getPayments(locationId), [])
    ]);

    const taskCurrency = (task.payload?.currency === 'MMK' || task.payload?.currency === 'USD')
      ? task.payload.currency
      : currency;

    const report = buildFinancialReport(
      reportTreatments,
      reportExpenses,
      reportMedicines,
      taskCurrency,
      undefined,
      reportMedicineSales,
      mergeLegacyPaymentRecords(scopedPayments, locationId)
    );
    const reportMarkdown = renderFinancialReportMarkdown(report, taskCurrency);
    const clinicLabel = locations.find(loc => loc.id === locationId)?.name || 'Dental Clinic';

    return `Daily clinic report for ${clinicLabel}\n\n${reportMarkdown}`;
  };

  const processScheduledTask = async (task: ScheduledTask) => {
    const payload = task.payload || {};
    const to = payload.to;
    const subject = payload.subject || (task.task_type === 'DAILY_REPORT_EMAIL' ? 'Daily Clinic Report' : 'Scheduled Email');
    const body = task.task_type === 'DAILY_REPORT_EMAIL'
      ? await buildDailyReportEmailBody(task)
      : (payload.body || '');

    if (!to) {
      throw new Error('Scheduled task is missing recipient email.');
    }

    await api.email.sendManagerEmail({
      to,
      subject,
      body,
      fromName: payload.fromName,
      fromEmail: payload.fromEmail,
      replyTo: payload.replyTo
    });
  };

  const processDueScheduledTasks = async () => {
    if (!isAuthenticated || !currentLocationId || scheduledTaskProcessorRef.current) return;

    scheduledTaskProcessorRef.current = true;
    try {
      const dueTasks = await api.scheduledTasks.getDue(new Date().toISOString(), currentLocationId);
      for (const task of dueTasks) {
        try {
          await api.scheduledTasks.markProcessing(task.id);
          await processScheduledTask(task);
          await api.scheduledTasks.markCompleted(task.id);
        } catch (error: any) {
          console.error('Scheduled task processing failed:', error);
          await api.scheduledTasks.markFailed(task.id, error?.message || 'Failed to process scheduled task.');
        }
      }
    } finally {
      scheduledTaskProcessorRef.current = false;
    }
  };

  useEffect(() => {
    if (currentView === 'users' && canAccessView('users')) {
      fetchUsers();
    }
    if (currentView === 'inventory' && canAccessView('inventory')) {
      fetchMedicines();
    }
    if (currentView === 'expenses' && canAccessView('expenses')) {
      fetchExpenses();
      fetchMedicineSales();
    }
    if (currentView === 'ai-assistant' && canAccessView('ai-assistant')) {
      fetchAssistantData().catch(err => {
        console.warn('Error fetching AI assistant data:', err);
      });
    }
  }, [currentView, currentLocationId, allowedViews]);

  useEffect(() => {
    if (currentView !== 'finance') {
      treatmentHistoryRequestRef.current += 1;
    }
  }, [currentView]);

  useEffect(() => {
    if (!isAuthenticated || auth.isPatient() || allowedViews.length === 0) {
      return;
    }

    // Doctor can temporarily access Clinical Focus when opening a patient chart from appointments.
    if (isDoctor && currentView === 'finance') {
      return;
    }

    if (!canAccessView(currentView)) {
      const fallbackView = allowedViews.includes('dashboard' as ViewState) ? 'dashboard' as ViewState : allowedViews[0];
      setCurrentView(fallbackView);
    } else {
      // Persist the current view to localStorage
      localStorage.setItem('currentView', currentView);
    }
  }, [allowedViews, currentView, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !currentLocationId) return;

    void processDueScheduledTasks();
    const interval = window.setInterval(() => {
      void processDueScheduledTasks();
    }, 30000);

    return () => window.clearInterval(interval);
  }, [isAuthenticated, currentLocationId, currency, locations]);

  const fetchMedicines = async () => {
    try {
      if (!currentLocationId) {
        setMedicines([]);
        setTopSellingMedicines([]);
        return;
      }
      const medData = await api.medicines.getAll(currentLocationId);
      setMedicines(medData);
      // Fetch top selling medicines for reporting
      const topSellingData = await api.medicines.getTopSelling(currentLocationId, 10);
      setTopSellingMedicines(topSellingData);
    } catch (err: any) {
      console.warn('Error fetching medicines:', err);
    }
  };

  const fetchExpenses = async () => {
    try {
      if (!currentLocationId) {
        setExpenses([]);
        return;
      }
      const expenseData = await api.expenses.getAll(currentLocationId);
      setExpenses(expenseData);
    } catch (err: any) {
      console.warn('Error fetching expenses:', err);
    }
  };

  const fetchMedicineSales = async () => {
    try {
      if (!currentLocationId) {
        setMedicineSales([]);
        return;
      }
      const salesData = await api.medicines.getSales(currentLocationId);
      setMedicineSales(salesData);
    } catch (err: any) {
      console.warn('Error fetching medicine sales:', err);
    }
  };

  const handlePatientSelect = async (patient: Patient) => {
    const requestId = ++treatmentHistoryRequestRef.current;
    const medicineRequestId = ++medicineHistoryRequestRef.current;
    const paymentRequestId = ++paymentHistoryRequestRef.current;
    const canViewPayments = auth.getSession()?.role !== 'doctor';
    setSelectedPatient(patient);
    setLatestTreatmentBatch([]);
    setPaymentDraft({ treatments: [], amountTendered: 0, previousBalance: 0, currentTreatmentTotal: 0, serviceFeeAmount: 0, serviceFeeCategory: null, paymentMethod: 'UNKNOWN', splitPayment: false, allocations: [] });
    setSelectedDoctorId('');
    setSelectedTeeth([]);
    setCurrentView('finance');
    setTreatmentHistory([]);
    setTreatmentHistoryLoading(true);
    setLoyaltyTransactions([]);
    setPatientFiles([]);
    setPatientMedicineSales([]);
    setPatientMedicineHistoryLoading(true);
    setPatientMedicineHistoryError(null);
    setPatientPaymentRecords([]);
    setPatientPaymentHistoryLoading(canViewPayments);
    setPatientPaymentHistoryError(null);

    const locationId = patient.location_id || currentLocationId;
    // Clinical Focus does not render commission-ledger breakdowns. Skipping that
    // optional enrichment removes an extra database request from chart startup.
    void api.treatments.getHistory(patient.id, { includeCommissionEntries: false })
      .then((history) => {
        if (requestId !== treatmentHistoryRequestRef.current) return;
        setTreatmentHistory(history);
        setTreatmentHistoryLoading(false);
      })
      .catch((err: any) => {
        if (requestId !== treatmentHistoryRequestRef.current) return;
        console.warn('Error fetching treatment history:', err);
        setTreatmentHistory([]);
        setTreatmentHistoryLoading(false);
      });

    if (canViewPayments) {
      void api.finance.getPayments(locationId, { patientId: patient.id })
        .then((payments) => {
          if (paymentRequestId !== paymentHistoryRequestRef.current) return;
          setPatientPaymentRecords(payments);
          setPatientPaymentHistoryLoading(false);
        })
        .catch((err: any) => {
          if (paymentRequestId !== paymentHistoryRequestRef.current) return;
          console.warn('Error fetching patient payment history:', err);
          setPatientPaymentRecords([]);
          setPatientPaymentHistoryLoading(false);
          setPatientPaymentHistoryError(err?.message || 'Check the connection and reopen this patient to try again.');
        });
    }

    void api.medicines.getSales(locationId, patient.id, { throwOnError: true })
      .then((patientSales) => {
        if (medicineRequestId !== medicineHistoryRequestRef.current) return;
        setPatientMedicineSales(patientSales);
        setPatientMedicineHistoryLoading(false);
      })
      .catch((err: any) => {
        if (medicineRequestId !== medicineHistoryRequestRef.current) return;
        console.warn('Error fetching patient medicine history:', err);
        setPatientMedicineHistoryLoading(false);
        setPatientMedicineHistoryError(err?.message || 'Check the connection and reopen this patient to try again.');
      });

    void api.loyalty.getTransactions(patient.id, locationId)
      .then((transactions) => {
        if (requestId !== treatmentHistoryRequestRef.current) return;
        setLoyaltyTransactions(transactions);
      })
      .catch((err: any) => {
        if (requestId !== treatmentHistoryRequestRef.current) return;
        console.warn('Error fetching loyalty transactions:', err);
        setLoyaltyTransactions([]);
      });

    void api.files.list(patient.id)
      .then((files) => {
        if (requestId !== treatmentHistoryRequestRef.current) return;
        setPatientFiles(files);
      })
      .catch((err: any) => {
        if (requestId !== treatmentHistoryRequestRef.current) return;
        console.warn('Error fetching patient files:', err);
        setPatientFiles([]);
      });
  };

  const fetchGlobalRecords = async () => {
    setLoading(true);
    try {
      const [records, payments, rescheduleLogs] = await Promise.all([
        api.treatments.getAllRecords(currentLocationId || undefined, { limit: null }),
        safeLoad('Audit log payments', api.finance.getPayments(currentLocationId || undefined), []),
        safeLoad('Audit log reschedule logs', api.appointmentRescheduleLogs.getAll(currentLocationId || undefined), [])
      ]);
      const session = auth.getSession();
      if (session?.role === 'doctor' && session.doctor_id) {
        setGlobalRecords(records.filter((record) => record.doctor_id === session.doctor_id));
        setPaymentRecords([]);
        setAppointmentRescheduleLogs([]);
      } else {
        setGlobalRecords(records);
        setPaymentRecords(mergeLegacyPaymentRecords(payments, currentLocationId || undefined));
        setAppointmentRescheduleLogs(rescheduleLogs);
      }
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // MLS saves only mutate one patient's ledger. Refetching that patient's rows
  // keeps the save dialog fast instead of reloading every clinic record, expense,
  // and payment while the user waits for the button.
  const refreshGlobalRecordsForPatient = async (patientId?: string | null) => {
    if (!patientId) {
      await fetchGlobalRecords();
      return;
    }
    try {
      const records = await api.treatments.getAllRecords(currentLocationId || undefined, {
        limit: null,
        patientId
      });
      const session = auth.getSession();
      const scopedRecords = session?.role === 'doctor' && session.doctor_id
        ? records.filter((record) => record.doctor_id === session.doctor_id)
        : records;
      setGlobalRecords((prev) => [...prev.filter((record) => record.patient_id !== patientId), ...scopedRecords].sort((a, b) => (
        String(b.date || '').localeCompare(String(a.date || '')) || String(a.id || '').localeCompare(String(b.id || ''))
      )));
    } catch (err) {
      console.error('Patient-scoped record refresh failed; falling back to a full reload.', err);
      await fetchGlobalRecords();
    }
  };

  const handlePaymentCorrected = async (updatedPayment: PaymentRecord) => {
    const updatedPatientBalance = updatedPayment.patientCurrentBalance ?? updatedPayment.remainingBalance;
    const applyPaymentUpdate = (items: PaymentRecord[]) => {
      if (updatedPayment.voidedAt) {
        return items.filter((item) => item.id !== updatedPayment.id);
      }
      const nextItems = items.some((item) => item.id === updatedPayment.id)
        ? items.map((item) => (item.id === updatedPayment.id ? updatedPayment : item))
        : [updatedPayment, ...items];

      return nextItems.sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date));
    };

    setPaymentRecords((prev) => applyPaymentUpdate(prev));
    setPatientPaymentRecords((prev) => applyPaymentUpdate(prev));
    setAuditPayments((prev) => applyPaymentUpdate(prev));
    setDashboardPayments((prev) => applyPaymentUpdate(prev));
    setAssistantPaymentRecords((prev) => applyPaymentUpdate(prev));
    setPatients((prev) => prev.map((patient) => (
      patient.id === updatedPayment.patientId
        ? { ...patient, balance: updatedPatientBalance }
        : patient
    )));
    setDashboardPatients((prev) => prev.map((patient) => (
      patient.id === updatedPayment.patientId
        ? { ...patient, balance: updatedPatientBalance }
        : patient
    )));

    if (selectedPatient?.id === updatedPayment.patientId) {
      setSelectedPatient({ ...selectedPatient, balance: updatedPatientBalance });
    }

    setAuditRefreshKey((key) => key + 1);
    await fetchGlobalRecords();
  };

  const checkDuplicatePatientDraft = async (params: {
    phone?: string | null;
    age?: number | string | null;
    name?: string | null;
  }) => {
    const phoneDigits = normalizePhoneDigits(params.phone);
    const parsedAge = typeof params.age === 'number'
      ? params.age
      : Number.parseInt(String(params.age || ''), 10);

    if (!phoneDigits || !Number.isFinite(parsedAge)) {
      return null;
    }

    const result = await api.patients.checkDuplicate({
      name: params.name || undefined,
      phone: params.phone || undefined,
      age: parsedAge
    });

    return result.isDuplicate ? result.match : null;
  };

  const validateNewPatientDuplicate = async () => {
    try {
      const match = await checkDuplicatePatientDraft({
        name: newPatientData.name,
        phone: newPatientData.phone,
        age: newPatientData.age
      });
      setPatientDuplicateWarning(
        match
          ? `Duplicate patient found: ${match.name} (${match.phone || 'no phone'}, age ${match.age ?? '-'})`
          : null
      );
      return match;
    } catch (error) {
      console.warn('Patient duplicate pre-check failed:', error);
      return null;
    }
  };

  const validateAppointmentLeadDuplicate = async () => {
    try {
      const match = await checkDuplicatePatientDraft({
        name: newAppointmentData.guest_name,
        phone: newAppointmentData.guest_phone,
        age: newAppointmentData.guest_age
      });
      setAppointmentDuplicateWarning(
        match
          ? `Existing patient found: ${match.name} (${match.phone || 'no phone'}, age ${match.age ?? '-'})`
          : null
      );
      return match;
    } catch (error) {
      console.warn('Appointment duplicate pre-check failed:', error);
      return null;
    }
  };

  const handleCreatePatient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    // Validate branch selection
    if (!newPatientData.location_id) {
      setToast({ show: true, message: 'Please select a branch/location for this patient.', type: 'error' });
      return;
    }

    setIsSubmitting(true);
    try {
      console.log('Creating patient with location_id:', newPatientData.location_id);
      const duplicateMatch = await checkDuplicatePatientDraft({
        name: newPatientData.name,
        phone: newPatientData.phone,
        age: newPatientData.age
      });
      if (duplicateMatch) {
        const duplicateMessage = `Duplicate patient found: ${duplicateMatch.name} (${duplicateMatch.phone || 'no phone'}, age ${duplicateMatch.age ?? '-'})`;
        setPatientDuplicateWarning(duplicateMessage);
        throw new Error(duplicateMessage);
      }
      const patientInput = {
        ...newPatientData,
        location_id: newPatientData.location_id,
        balance: 0,
        ...(showPatientCreationDate ? { created_at: patientCreationDate } : {})
      } as Parameters<typeof api.patients.create>[0];
      const createdPatient = await api.patients.create(patientInput);
      if (convertingLeadAppointment) {
        await api.appointments.update(convertingLeadAppointment.id, {
          patient_id: createdPatient.id,
          converted_patient_id: createdPatient.id
        });
      }
      setShowPatientModal(false);
      await fetchInitialData(currentLocationId || undefined);
      setNewPatientData({
        name: '',
        email: '',
        phone: '',
        medicalHistory: '',
        password: '',
        age: undefined,
        address: '',
        city: '',
        township: '',
        patient_type: activePatientTypeOptions[0] || DEFAULT_PATIENT_TYPE_NAME,
        location_id: ''
      });
      setPatientDuplicateWarning(null);
      setShowPatientCreationDate(false);
      setPatientCreationDate(toLocalDateInputValue());
      setConvertingLeadAppointment(null);
      const createdBranch = locations.find((loc) => loc.id === createdPatient.location_id);
      const viewingDifferentBranch = !!createdPatient.location_id && !!currentLocationId && createdPatient.location_id !== currentLocationId;
      const baseSuccessMessage = 'Patient registered successfully. Service fees will be handled during payment collection based on the fee settings.';
      const branchHint = viewingDifferentBranch
        ? ` Saved to ${createdBranch?.name || 'another branch'}. Switch branch in Settings to view it.`
        : '';
      setToast({
        message: `${baseSuccessMessage}${branchHint}`,
        type: 'success',
        show: true
      });
    } catch (err: any) {
      console.error('Patient creation error:', err);
      const message = isDuplicatePatientValidationError(err)
        ? err.message
        : err.message;
      setToast({ show: true, message: `Failed to register patient: ${message}`, type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeletePatient = async (id: string) => {
    try {
      await api.patients.delete(id);
      if (selectedPatient?.id === id) {
        handleClosePatient();
      }
      await fetchInitialData();
    } catch (err: any) {
      throw err;
    }
  };

  const closeReceiptViewer = () => {
    setShowReceipt(false);
    setReceiptViewerPatient(null);
    setActivePaymentReceiptSnapshot(null);
    setSelectedTreatmentsForReceipt([]);
    setSelectedMedicineSalesForReceipt([]);
  };

  const resolvePaymentReceiptSnapshotForViewer = (payment: PaymentRecord): PaymentReceiptSnapshot => (
    payment.receiptSnapshot || buildLegacyPaymentReceiptSnapshot(payment, {
      appName,
      receiptHeaderTitle,
      receiptInfo,
      currency
    })
  );

  const handleOpenStoredPaymentReceipt = (payment: PaymentRecord) => {
    const snapshot = resolvePaymentReceiptSnapshotForViewer(payment);
    const matchedPatient = patients.find((patient) => patient.id === payment.patientId);

    setReceiptViewerPatient(
      matchedPatient || {
        id: payment.patientId,
        patient_unique_id: snapshot.patient.patientUniqueId || '',
        location_id: payment.location_id || '',
        name: snapshot.patient.name || payment.patient_name || 'Unknown Patient',
        email: snapshot.patient.email || '',
        phone: snapshot.patient.phone || '',
        balance: payment.remainingBalance,
        loyalty_points: 0
      }
    );
    setActivePaymentReceiptSnapshot(snapshot);
    setSelectedTreatmentsForReceipt([]);
    setSelectedMedicineSalesForReceipt([]);
    setLastPaymentAmount(payment.amount);
    setLastPaymentRecord(payment);
    setShowReceipt(true);
  };

  const openPaymentModalWithCategory = (category: 'NEW' | 'RETURNING' | null, explicitServiceFeeAmount?: number) => {
    const currentBatchForPatient = latestTreatmentBatch.filter(
      (record) => record.patient_id === selectedPatient?.id
    );
    const currentTreatmentTotal = currentBatchForPatient.reduce(
      (sum, record) => sum + Math.max(0, Number(record.cost || 0)),
      0
    );
    const serviceFeeAmount = explicitServiceFeeAmount !== undefined
      ? Math.max(0, explicitServiceFeeAmount)
      : category === 'NEW'
        ? Math.max(0, clinicalFeeNewPatientAmount)
        : category === 'RETURNING'
          ? Math.max(0, clinicalFeeReturningPatientAmount)
          : 0;
    const previousBalance = Math.max(
      0,
      Math.max(0, Number(selectedPatient?.balance || 0)) - currentTreatmentTotal
    );

    setPaymentDraft({
      treatments: currentBatchForPatient,
      amountTendered: Math.max(0, Number(selectedPatient?.balance || 0)) + serviceFeeAmount,
      previousBalance,
      currentTreatmentTotal,
      serviceFeeAmount,
      serviceFeeCategory: category,
      paymentMethod: 'UNKNOWN',
      splitPayment: false,
      allocations: []
    });
    paymentSubmitInFlightRef.current = false;
    paymentSubmissionKeyRef.current = createPaymentSubmissionKey();
    setShowPaymentModal(true);
  };

  const resolvePaymentServiceFeePreview = (): PaymentServiceFeePreview => {
    if (!selectedPatient?.id) {
      return null;
    }

    const today = toLocalISODate(new Date());
    const hasPreviousCompletedAppointment = appointments.some((appointment) => {
      const patientId = (appointment.patient_id || '').trim();
      return (
        patientId === selectedPatient.id &&
        appointment.status === 'Completed' &&
        typeof appointment.date === 'string' &&
        appointment.date < today
      );
    });
    const hasPreviousTreatment = [...treatmentHistory, ...globalRecords].some((record) => {
      return (
        record.patient_id === selectedPatient.id &&
        typeof record.date === 'string' &&
        record.date < today
      );
    });
    const category: 'NEW' | 'RETURNING' = hasPreviousCompletedAppointment || hasPreviousTreatment ? 'RETURNING' : 'NEW';
    const feeAmount = category === 'RETURNING'
      ? Math.max(0, clinicalFeeReturningPatientAmount)
      : Math.max(0, clinicalFeeNewPatientAmount);
    const suggestedFeeAmount = getSuggestedServiceFeeAmount({
      enabled: clinicalFeeEnabled,
      configuredAmount: feeAmount,
      hasRecordedFeeForVisit: hasRecordedServiceFeeForVisit(paymentRecords, selectedPatient.id, today)
    });
    const hasSuggestedFee = suggestedFeeAmount > 0;

    return {
      category,
      feeAmount: suggestedFeeAmount,
      hasSuggestedFee
    };
  };

  const handleOpenPaymentModal = (_treatments: ClinicalRecord[]) => {
    const preview = resolvePaymentServiceFeePreview();

    if (preview) {
      setPaymentServiceFeePreview(preview);
      setManualServiceFeeAmount(String(preview.feeAmount));
      setShowPaymentCategoryModal(true);
      return;
    }

    openPaymentModalWithCategory(null);
  };

  const handleOpenServiceFeePayment = () => {
    if (!selectedPatient) return;

    if (Math.max(0, Number(selectedPatient.balance || 0)) > 0) {
      handleOpenPaymentModal(treatmentHistory);
      return;
    }

    const preview = resolvePaymentServiceFeePreview();
    if (preview) {
      setPaymentServiceFeePreview(preview);
      setManualServiceFeeAmount(String(preview.feeAmount));
      setShowPaymentCategoryModal(true);
    }
  };

  const resetAppointmentForm = () => {
    setAppointmentPatientMode('registered');
    setNewAppointmentData({
      date: '',
      time: '',
      type: appointmentTypeOptions[0] || '',
      status: 'Scheduled',
      patient_id: '',
      doctor_id: '',
      guest_name: '',
      guest_phone: '',
      guest_email: '',
      guest_age: '',
      guest_address: '',
      guest_password: '',
      guest_source: '',
      guest_notes: '',
      location_id: currentLocationId || ''
    });
    setDoctorSearchQuery('');
    setShowDoctorDropdown(false);
    setAppointmentClinicalFocus('');
    setAppointmentGeneralNotes('');
    setAppointmentRescheduleReasonPreset('Patient did not arrive');
    setAppointmentRescheduleReasonCustom('');
    setAppointmentDuplicateWarning(null);
  };

  const createEmptyDoctorCommissionRow = (): DoctorTreatmentCommission => ({
    treatment_id: '',
    commission_rate: 0,
    fixed_amount: 0
  });

  const resetDoctorCommissionEditor = () => {
    setDoctorCommissionRows([]);
    setDoctorCommissionAdvancedOpen(false);
    setDoctorCommissionLoading(false);
    setDoctorCommissionLoadError('');
    setIsLoggingOut(false);
  };

  useEffect(() => {
    if (!showDoctorModal) {
      resetDoctorCommissionEditor();
      return;
    }

    if (!editingDoctor?.id) {
      setDoctorCommissionRows([]);
      setDoctorCommissionLoading(false);
      setDoctorCommissionLoadError('');
      return;
    }

    let cancelled = false;

    const loadDoctorCommissions = async () => {
      setDoctorCommissionLoading(true);
      setDoctorCommissionLoadError('');
      try {
        const rows = await api.doctorTreatmentCommissions.getByDoctor(editingDoctor.id);
        if (!cancelled) {
          setDoctorCommissionRows(rows);
          setDoctorCommissionAdvancedOpen(rows.length > 0);
        }
      } catch (err: any) {
        if (!cancelled) {
          const message = err.message || 'Failed to load doctor treatment commissions.';
          setDoctorCommissionLoadError(message);
          alert(message);
        }
      } finally {
        if (!cancelled) {
          setDoctorCommissionLoading(false);
        }
      }
    };

    void loadDoctorCommissions();

    return () => {
      cancelled = true;
    };
  }, [showDoctorModal, editingDoctor?.id]);

  const handleCreateAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const targetLocationId = (newAppointmentData.location_id || '').trim() || currentLocationId;
    if (!targetLocationId) {
      setToast({ show: true, message: 'Please select a branch/location for this appointment.', type: 'error' });
      return;
    }
    setIsSubmitting(true);
    try {
      const compiledNotes = buildAppointmentClinicalFocusNotes({
        clinicalFocus: appointmentClinicalFocus,
        notes: appointmentGeneralNotes
      });
      let resolvedPatientId = appointmentPatientMode === 'registered' ? (newAppointmentData.patient_id || '').trim() : '';
      let guestName = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_name || '').trim() : '';
      let guestPhone = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_phone || '').trim() : '';
      const guestEmail = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_email || '').trim() : '';
      const guestAge = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_age || '').trim() : '';
      const guestAddress = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_address || '').trim() : '';
      const guestPassword = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_password || '').trim() : '';
      const guestSource = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_source || '').trim() : '';
      const guestNotes = appointmentPatientMode === 'lead' ? (newAppointmentData.guest_notes || '').trim() : '';

      if (!editingAppointment && appointmentPatientMode === 'lead') {
        if (!guestName || !guestPhone) {
          throw new Error('Please enter the new patient name and phone number.');
        }
        const duplicateMatch = await checkDuplicatePatientDraft({
          name: guestName,
          phone: guestPhone,
          age: guestAge
        });
        if (duplicateMatch) {
          const duplicateMessage = `Duplicate patient found: ${duplicateMatch.name} (${duplicateMatch.phone || 'no phone'}, age ${duplicateMatch.age ?? '-'})`;
          setAppointmentDuplicateWarning(duplicateMessage);
          throw new Error(`${duplicateMessage}. Please choose the registered patient instead.`);
        }

        const createdPatient = await api.patients.create({
          name: guestName,
          email: guestEmail || undefined,
          phone: guestPhone,
          password: guestPassword || undefined,
          age: guestAge ? parseInt(guestAge, 10) : undefined,
          address: guestAddress || undefined,
          medicalHistory: guestNotes || undefined,
          patient_type: mapLeadSourceToPatientType(guestSource, activePatientTypeOptions),
          location_id: targetLocationId,
          balance: 0
        });
        resolvedPatientId = createdPatient.id;

        guestName = '';
        guestPhone = '';
      }

      const payload: Partial<Appointment> = {
        date: newAppointmentData.date,
        time: newAppointmentData.time,
        type: newAppointmentData.type,
        status: newAppointmentData.status,
        patient_id: resolvedPatientId || null,
        guest_name: appointmentPatientMode === 'lead' && !resolvedPatientId ? guestName : null,
        guest_phone: appointmentPatientMode === 'lead' && !resolvedPatientId ? guestPhone : null,
        guest_source: appointmentPatientMode === 'lead' && !resolvedPatientId ? guestSource : null,
        guest_notes: appointmentPatientMode === 'lead' && !resolvedPatientId ? guestNotes : null,
        doctor_id: (newAppointmentData.doctor_id || '').trim() || undefined,
        location_id: targetLocationId,
        notes: compiledNotes,
        converted_patient_id: newAppointmentData.converted_patient_id || null
      };
      if (editingAppointment) {
        const isDateRescheduled = editingAppointment.date !== payload.date;
        const rescheduleReason = getAppointmentRescheduleReason();
        if (isDateRescheduled && !rescheduleReason) {
          throw new Error('Please provide a reschedule reason before updating the appointment date.');
        }

        const existingDoctorId = String(editingAppointment.doctor_id || '').trim();
        const requestedDoctorId = String(payload.doctor_id || '').trim();
        const isDoctorChanged = existingDoctorId !== requestedDoctorId;
        if (isDoctorChanged) {
          if (!isAdmin) {
            throw new Error('Only an administrator can change the assigned doctor.');
          }
          if (!requestedDoctorId) {
            throw new Error('Choose a doctor. Removing a doctor assignment requires the Correct Doctor workflow.');
          }

          const currentStaffSession = auth.getSession();
          if (!currentStaffSession?.staffAuthToken || !currentStaffSession.userId) {
            throw new Error('A valid administrator session is required. Sign in again and retry.');
          }

          const correctionPreview = await api.appointments.getDoctorCorrectionPreview(
            editingAppointment.id,
            { userId: currentStaffSession.userId, authToken: currentStaffSession.staffAuthToken }
          );
          if (correctionPreview.treatments.length > 0) {
            throw new Error('This visit has related treatment records. Use Correct Doctor from the appointment actions to review and reassign them safely.');
          }

          await api.appointments.correctDoctor({
            appointmentId: editingAppointment.id,
            expectedOldDoctorId: editingAppointment.doctor_id || null,
            newDoctorId: requestedDoctorId,
            treatmentIds: [],
            reason: 'Doctor changed by administrator while editing the appointment.',
            actor: { userId: currentStaffSession.userId, authToken: currentStaffSession.staffAuthToken }
          });
        }

        await api.appointments.update(
          editingAppointment.id,
          payload,
          isDateRescheduled
            ? {
                rescheduleAudit: {
                  reason: rescheduleReason,
                  adminUserId: auth.getSession()?.userId || null,
                  adminName: currentUser || auth.getSession()?.username || null
                }
              }
            : undefined
        );
      } else {
        payload.created_by_user_id = auth.getSession()?.userId || null;
        payload.created_by_user_name = currentUser || auth.getSession()?.username || null;
        await api.appointments.create(payload);
      }
      setShowAppointmentModal(false);
      await fetchInitialData(currentLocationId || undefined);
      setAppointmentPageRefreshKey((key) => key + 1);
      const targetBranch = locations.find((loc) => loc.id === targetLocationId);
      const viewingDifferentBranch = !!currentLocationId && targetLocationId !== currentLocationId;
      const branchHint = viewingDifferentBranch
        ? ` Saved to ${targetBranch?.name || 'another branch'}. Switch branch in Settings to view it.`
        : '';
      setToast({
        message: editingAppointment ? `Appointment updated successfully.${branchHint}` : `Appointment created successfully.${branchHint}`,
        type: 'success',
        show: true
      });
      setEditingAppointment(null);
      resetAppointmentForm();
    } catch (err: any) {
      setToast({
        show: true,
        message: `Failed to ${editingAppointment ? 'update' : 'create'} appointment: ${err.message || 'An unexpected error occurred.'}`,
        type: 'error'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateAppointmentFromClinical = async (data: Partial<Appointment>) => {
    if (!data?.patient_id) {
      throw new Error('Please select a patient before scheduling an appointment.');
    }
    if (!data?.date || !data?.time) {
      throw new Error('Appointment date and time are required.');
    }
    if (!data?.type) {
      throw new Error('Please select a treatment type.');
    }
    if (!currentLocationId) {
      throw new Error('Select a branch before creating appointments.');
    }

    await api.appointments.create({
      ...data,
      location_id: currentLocationId,
      status: 'Scheduled',
      created_by_user_id: auth.getSession()?.userId || null,
      created_by_user_name: currentUser || auth.getSession()?.username || null
    });

    await fetchInitialData();
  };

  const handleDoctorChange = (doctorId: string) => {
    const selectedDoctor = doctors.find((doctor) => doctor.id === doctorId);
    setNewAppointmentData({ ...newAppointmentData, doctor_id: doctorId || undefined });
    setDoctorSearchQuery(selectedDoctor ? selectedDoctor.name : '');
  };

  const handleAppointmentPatientChange = (patientId: string) => {
    const trimmedPatientId = patientId.trim();
    const preferredDoctorId = trimmedPatientId ? recentDoctorByPatientId.get(trimmedPatientId) || '' : '';
    const selectedDoctor = doctors.find((doctor) => doctor.id === preferredDoctorId);

    setNewAppointmentData({
      ...newAppointmentData,
      patient_id: trimmedPatientId,
      doctor_id: preferredDoctorId || undefined
    });
    setDoctorSearchQuery(selectedDoctor ? selectedDoctor.name : '');
  };

  const handleDateChange = (date: string) => {
    setNewAppointmentData({ ...newAppointmentData, date });
  };

  const getAppointmentRescheduleReason = () => {
    const preset = appointmentRescheduleReasonPreset.trim();
    if (preset === 'Other') {
      return appointmentRescheduleReasonCustom.trim();
    }
    return preset;
  };

  const handleCreateDoctor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || doctorCommissionLoading || doctorCommissionLoadError) return;
    setIsSubmitting(true);

    const isDoctorTransferValidationError = (error: unknown) =>
      error instanceof Error && error.message.includes('Cannot transfer doctor: Doctor has existing appointments or treatment history in this branch.');

    const getDoctorTransferBlockedReasons = (recordState: { hasAppointments: boolean; hasTreatments: boolean; hasAny: boolean }) => {
      const reasons: string[] = [];
      if (recordState.hasAppointments) reasons.push('Appointments');
      if (recordState.hasTreatments) reasons.push('Treatment Records');
      return reasons;
    };

    const trimmedDoctorPassword = (newDoctorData.password || '').trim();
    if (!editingDoctor && !trimmedDoctorPassword) {
      setToast({ show: true, message: 'Password is required for a new doctor account.', type: 'error' });
      setIsSubmitting(false);
      return;
    }
    if (trimmedDoctorPassword && !(newDoctorData.email || '').trim()) {
      setToast({ show: true, message: 'Doctor email is required when setting a doctor password.', type: 'error' });
      setIsSubmitting(false);
      return;
    }
    const targetDoctorLocationIds = Array.from(new Set([
      ...((newDoctorData.location_ids || []).map((id) => id.trim()).filter(Boolean)),
      (newDoctorData.location_id || '').trim()
    ].filter(Boolean)));
    if (targetDoctorLocationIds.length === 0) {
      setToast({ show: true, message: 'Please select at least one branch/location for this doctor.', type: 'error' });
      setIsSubmitting(false);
      return;
    }
    
    // Validate schedules before submitting
    const schedules = (newDoctorData.schedules || []).filter(sched => {
      // Filter out schedules with missing or invalid times
      if (!sched.start_time || !sched.end_time) return false;
      
      // Validate that end_time > start_time
      const start = new Date(`2000-01-01T${sched.start_time}`);
      const end = new Date(`2000-01-01T${sched.end_time}`);
      if (end <= start) {
        setToast({
          show: true,
          message: `Invalid schedule: End time must be after start time for ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][sched.day_of_week]}.`,
          type: 'error'
        });
        return false;
      }
      return true;
    }).map(sched => ({
      // Remove id if present (will be auto-generated) and ensure proper structure
      day_of_week: sched.day_of_week,
      start_time: sched.start_time,
      end_time: sched.end_time
    }));

    // Check for duplicate day_of_week entries
    const daySet = new Set(schedules.map(s => s.day_of_week));
    if (daySet.size !== schedules.length) {
      setToast({ show: true, message: 'You cannot have multiple schedules for the same day. Please combine them into one schedule with a longer time range.', type: 'error' });
      setIsSubmitting(false);
      return;
    }

    const useFlatVisitCommission = usesFlatVisitCommission({
      commissionType: newDoctorData.commission_type,
      specialization: newDoctorData.specialization
    });
    if (editingDoctor && (doctorCommissionLoading || doctorCommissionLoadError)) {
      setToast({
        show: true,
        message: doctorCommissionLoading
          ? 'Please wait for custom commission rates to finish loading before saving.'
          : 'Custom commission rates could not be loaded. Close and reopen this doctor before saving to prevent data loss.',
        type: 'error'
      });
      setIsSubmitting(false);
      return;
    }
    const activeCommissionValue = Number(useFlatVisitCommission
      ? newDoctorData.commission_per_visit
      : newDoctorData.commission_percentage);
    if (!Number.isFinite(activeCommissionValue) || activeCommissionValue < 0) {
      setToast({
        show: true,
        message: useFlatVisitCommission
          ? 'Per-visit commission must be a valid non-negative amount.'
          : 'Commission percentage must be between 0 and 100.',
        type: 'error'
      });
      setIsSubmitting(false);
      return;
    }
    if (!useFlatVisitCommission && activeCommissionValue > 100) {
      setToast({ show: true, message: 'Commission percentage must be between 0 and 100.', type: 'error' });
      setIsSubmitting(false);
      return;
    }

    const normalizedCommissionRows = doctorCommissionRows
      .filter((row) => row.treatment_id)
      .map((row) => ({
        treatment_id: row.treatment_id,
        commission_rate: useFlatVisitCommission ? 0 : Number(row.commission_rate ?? 0),
        fixed_amount: useFlatVisitCommission ? Number(row.fixed_amount ?? 0) : null
      }));

    const uniqueTreatmentIds = new Set(normalizedCommissionRows.map((row) => row.treatment_id));
    if (uniqueTreatmentIds.size !== normalizedCommissionRows.length) {
      setToast({ show: true, message: 'Each treatment can only have one custom commission rate.', type: 'error' });
      setIsSubmitting(false);
      return;
    }

    const invalidCommissionValue = normalizedCommissionRows.find((row) => {
      const value = useFlatVisitCommission ? row.fixed_amount : row.commission_rate;
      return !Number.isFinite(value) || value < 0 || (!useFlatVisitCommission && value > 100);
    });
    if (invalidCommissionValue) {
      setToast({
        show: true,
        message: useFlatVisitCommission
          ? 'Custom fixed commission amounts must be valid non-negative amounts.'
          : 'Custom commission rates must be between 0 and 100.',
        type: 'error'
      });
      setIsSubmitting(false);
      return;
    }

    try {
      const doctorDataToSave = {
        ...newDoctorData,
        specialization: newDoctorData.specialization?.trim() || 'General',
        location_id: targetDoctorLocationIds[0],
        location_ids: targetDoctorLocationIds,
        password: trimmedDoctorPassword || undefined,
        schedules: schedules
      };

      let savedDoctor: Doctor;
      if (editingDoctor) {
        savedDoctor = await api.doctors.update(editingDoctor.id, doctorDataToSave);
      } else {
        savedDoctor = await api.doctors.create(doctorDataToSave);
      }

      try {
        const currentStaffSession = auth.getSession();
        if (!currentStaffSession?.staffAuthToken || currentStaffSession.role === 'patient') {
          throw new Error('A valid staff session is required to save doctor commission settings.');
        }
        await api.doctorTreatmentCommissions.replaceForDoctor(
          savedDoctor.id,
          useFlatVisitCommission ? 'fixed' : 'percentage',
          Number(newDoctorData.commission_percentage || 0),
          Number(newDoctorData.commission_per_visit || 0),
          normalizedCommissionRows,
          { userId: currentStaffSession.userId, authToken: currentStaffSession.staffAuthToken }
        );
      } catch (commissionErr: any) {
        if (!editingDoctor) {
          await api.doctors.delete(savedDoctor.id);
        }
        throw new Error(commissionErr.message || 'Failed to save doctor commission settings.');
      }
      setToast({
        show: true,
        message: editingDoctor
          ? 'Doctor information updated successfully.'
          : 'Doctor added successfully.',
        type: 'success'
      });
      setShowDoctorModal(false);
      fetchInitialData();
      setEditingDoctor(null);
      setNewDoctorData({ name: '', email: '', phone: '', specialization: 'General', commission_type: 'percentage', password: '', commission_percentage: 0, commission_per_visit: 0, schedules: [], location_id: currentLocationId || '', location_ids: currentLocationId ? [currentLocationId] : [] });
      resetDoctorCommissionEditor();
    } catch (err: any) {
      if (isDoctorTransferValidationError(err) && editingDoctor) {
        try {
          const recordState = await api.doctors.checkDoctorRecords(editingDoctor.id, editingDoctor.location_id || undefined);
          setDoctorTransferBlockedReasons(getDoctorTransferBlockedReasons(recordState));
        } catch (recordError) {
          console.warn('Doctor transfer validation details lookup failed:', recordError);
          setDoctorTransferBlockedReasons(['Appointments or Treatment Records']);
        }
        setDoctorTransferBlockedOpen(true);
        return;
      }
      setToast({
        show: true,
        message: `${editingDoctor ? 'Failed to update doctor' : 'Failed to add doctor'}: ${err.message || 'An unexpected error occurred.'}`,
        type: 'error'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteDoctor = async (id: string) => {
    try {
      await api.doctors.delete(id);
      fetchInitialData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateDoctorProfile = async (data: Partial<Doctor>) => {
    const session = auth.getSession();
    if (!session?.doctor_id) {
      throw new Error('Doctor session is invalid. Please sign in again.');
    }

    await api.doctors.update(session.doctor_id, {
      ...data,
      location_id: currentLocationId
    });
    await fetchInitialData(currentLocationId || undefined);
    setToast({
      message: 'Doctor profile updated successfully.',
      type: 'success',
      show: true
    });
  };

  const handleDeleteAllRecords = async () => {
    try {
      await api.treatments.deleteAllRecords(currentLocationId || undefined);
      await fetchGlobalRecords();
      setAuditRefreshKey((key) => key + 1);
      alert('All audit log records for the current branch have been deleted successfully.');
    } catch (err: any) {
      alert(err.message || 'Failed to delete records');
    }
  };

  const handleDeleteAppointment = async (id: string) => {
    try {
      await api.appointments.delete(id);
      fetchInitialData();
      setAppointmentPageRefreshKey((key) => key + 1);
      setToast({
        message: 'Appointment deleted successfully.',
        type: 'success',
        show: true
      });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const buildUserPayload = (userData: Partial<User>): Partial<User> => {
    const nextRole = userData.role || 'normal';
    const nextAllowedTabs = nextRole === 'admin'
      ? FULL_ACCESS_TAB_PERMISSIONS
      : resolveAllowedTabs('normal', userData.allowed_tabs).filter((tab) => (
          tab !== 'branch-switching' || !userData.location_id
        ));

    return {
      ...userData,
      location_id: userData.location_id || null,
      role: nextRole,
      allowed_tabs: nextAllowedTabs
    };
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setUserFormError(null);
    setIsSubmitting(true);
    try {
      const payload = buildUserPayload(newUserData);
      if (payload.role === 'normal' && (!payload.allowed_tabs || payload.allowed_tabs.length === 0)) {
        setUserFormError('Select at least one tab for this normal account.');
        setIsSubmitting(false);
        return;
      }

      if (editingUser) {
        const updatedUser = await api.users.update(editingUser.id, payload);
        await syncCurrentSessionUser(updatedUser);
      } else {
        if (!newUserData.password || newUserData.password === '') {
          setUserFormError('Password is required for a new user account.');
          setIsSubmitting(false);
          return;
        }
        await api.users.create(payload);
      }
      setShowUserModal(false);
      setEditingUser(null);
      setUserFormError(null);
      setNewUserData(getDefaultUserFormData());
      if (auth.getSession()?.role === 'admin') {
        fetchUsers();
      } else {
        setUsers([]);
      }
      setToast({
        message: editingUser ? 'User account updated successfully.' : 'User account created successfully.',
        type: 'success',
        show: true
      });
    } catch (err: any) {
      setUserFormError(err.message || 'Unable to save this user right now.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteUser = async (id: string) => {
    try {
      await api.users.delete(id);
      fetchUsers();
      setToast({
        message: 'User account deleted successfully.',
        type: 'success',
        show: true
      });
    } catch (err: any) {
      setToast({
        message: err.message || 'Failed to delete this user account.',
        type: 'error',
        show: true
      });
    }
  };

  const handleCreateMedicine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (editingMedicine) {
        await api.medicines.update(editingMedicine.id, newMedicineData);
      } else {
        await api.medicines.create({ ...newMedicineData, location_id: currentLocationId });
      }
      setShowMedicineModal(false);
      setEditingMedicine(null);
      setNewMedicineData({ name: '', description: '', unit: 'pack', item_type: 'Medicine', price: 0, stock: 0, min_stock: 0, quantity_step: 1, category: '' });
      fetchMedicines();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteMedicine = async (id: string) => {
    try {
      await api.medicines.delete(id);
      fetchMedicines();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (!currentLocationId) {
        throw new Error('Please select a clinic location before logging expenses.');
      }
      if (editingExpense) {
        await api.expenses.update(editingExpense.id, newExpenseData);
      } else {
        await api.expenses.create({ ...newExpenseData, location_id: currentLocationId });
      }
      setShowExpenseModal(false);
      setEditingExpense(null);
      setNewExpenseData(getDefaultExpenseFormData());
      fetchExpenses();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteExpense = async (id: string) => {
    try {
      await api.expenses.delete(id);
      fetchExpenses();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateAppointmentStatus = async (
    id: string,
    status: 'Scheduled' | 'Completed' | 'Cancelled',
    options?: { skipClinicalFee?: boolean }
  ) => {
    try {
      const result = await api.appointments.updateStatus(id, status, options);
      await fetchInitialData(currentLocationId || undefined);
      setAppointmentPageRefreshKey((key) => key + 1);
      if (status === 'Completed' && result) {
        setToast({ message: 'Appointment completed successfully.', type: 'success', show: true });
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateCancellationOutcome = async (
    id: string,
    outcome: import('./types').CancellationOutcome | null,
    completedLaterAppointmentId?: string | null
  ) => {
    await api.appointments.updateCancellationOutcome(id, outcome, completedLaterAppointmentId);
    await fetchDashboardData(dashboardLocationId, locations);
  };

  const handleCreateLocation = async (locData: Partial<Location>) => {
    try {
      await api.locations.create(locData);
      fetchInitialData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateLocation = async (id: string, locData: Partial<Location>) => {
    try {
      await api.locations.update(id, locData);
      fetchInitialData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteLocation = async (id: string) => {
    try {
      await api.locations.delete(id);
      fetchInitialData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleCreateTreatmentType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (editingTreatmentType) {
        await api.treatments.updateType(editingTreatmentType.id, newTreatmentTypeData);
      } else {
        await api.treatments.createType({ ...newTreatmentTypeData, location_id: currentLocationId });
      }
      const updatedTypes = await api.treatments.getTypes(currentLocationId);
      setTreatmentTypes(updatedTypes);
      setShowTreatmentTypeModal(false);
      setEditingTreatmentType(null);
      setNewTreatmentTypeData({ name: '', cost: 0, category: '' });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteTreatmentType = async (id: string) => {
    try {
      await api.treatments.deleteType(id);
      setTreatmentTypes(treatmentTypes.filter(t => t.id !== id));
      setServiceToDelete(null);
      setDeleteServiceConfirmOpen(false);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRedeemPoints = async (points: number, amount: number, patientOverride?: Patient) => {
    const patient = patientOverride || selectedPatient;
    if (!patient) return;
    try {
      const result = await api.loyalty.redeemPoints(patient.id, currentLocationId || patient.location_id, points, amount);
      const updatedPatient = {
        ...patient,
        balance: result.new_balance,
        loyalty_points: result.new_points
      };
      setPatients(prev => prev.map(p => p.id === patient.id ? updatedPatient : p));
      setDashboardPatients(prev => prev.map(p => p.id === patient.id ? updatedPatient : p));
      setAssistantPatients(prev => prev.map(p => p.id === patient.id ? updatedPatient : p));
      if (selectedPatient?.id === patient.id) setSelectedPatient(updatedPatient);
      setToast({ message: `Redeemed ${points} points.`, type: 'success', show: true });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleTreatmentSubmit = async (treatment: TreatmentType, chargeLines?: TreatmentChargeLine[]) => {
    if (!selectedPatient) return;
    if (!useFlatRate && selectedTeeth.length === 0) {
      alert('Please select at least one tooth, or enable ALL TEETH before recording this treatment.');
      return;
    }
    
    const defaultChargeLines: TreatmentChargeLine[] = chargeLines?.length
      ? chargeLines
      : [{
          teeth: selectedTeeth,
          cost: useFlatRate ? treatment.cost : (treatment.cost * selectedTeeth.length),
          standardCost: useFlatRate ? treatment.cost : (treatment.cost * selectedTeeth.length)
        }];
    
    try {
      const recordedResponses = [];
      for (const line of defaultChargeLines) {
        const lineCost = Math.max(0, Number(line.cost || 0));
        const standardCost = Math.max(0, Number(line.standardCost || lineCost));
        const treatmentDiscountAmount = Math.max(0, standardCost - lineCost);
        const pricingNote = treatmentDiscountAmount > 0
          ? (lineCost === 0 ? 'FOC' : 'DISCOUNT')
          : null;

        const res = await api.treatments.record({
          location_id: currentLocationId,
          patient_id: selectedPatient.id,
          doctor_id: selectedDoctorId || undefined,
          treatment_type_id: treatment.id,
          teeth: line.teeth,
          description: treatment.name,
          cost: lineCost,
          standardCost,
          discountAmount: treatmentDiscountAmount,
          pricingNote
        });
        recordedResponses.push(res);
      }

      const latestResponse = recordedResponses[recordedResponses.length - 1];
      const newRecords = recordedResponses.map((response) => response.record);
      setLatestTreatmentBatch((previous) => mergeTreatmentRecordsById(previous, newRecords));
      treatmentHistoryRequestRef.current += 1;
      
      setSelectedPatient({ ...selectedPatient, balance: latestResponse?.new_balance ?? selectedPatient.balance });
      setTreatmentHistory((prev) => [...newRecords, ...prev]);

      const completedAppointmentIds = new Set(
        recordedResponses.flatMap((response) => response.completed_appointment_ids || [])
      );
      if (completedAppointmentIds.size > 0) {
        const completedDoctorName = newRecords.find((record) => record.doctor_name?.trim())?.doctor_name?.trim() || undefined;
        setAppointments(prev => prev.map(appointment =>
          completedAppointmentIds.has(appointment.id)
            ? { ...appointment, status: 'Completed', doctor_name: completedDoctorName || appointment.doctor_name }
            : appointment
        ));
        setDashboardAppointments(prev => prev.map(appointment =>
          completedAppointmentIds.has(appointment.id)
            ? { ...appointment, status: 'Completed', doctor_name: completedDoctorName || appointment.doctor_name }
            : appointment
        ));
        setAssistantAppointments(prev => prev.map(appointment =>
          completedAppointmentIds.has(appointment.id)
            ? { ...appointment, status: 'Completed', doctor_name: completedDoctorName || appointment.doctor_name }
            : appointment
        ));
        setToast({
          message: `${newRecords.length} treatment ${newRecords.length === 1 ? 'record' : 'records'} saved and the linked appointment was marked completed.`,
          type: 'success',
          show: true
        });
      } else {
        setToast({
          message: `${newRecords.length} treatment ${newRecords.length === 1 ? 'record' : 'records'} saved.`,
          type: 'success',
          show: true
        });
      }
      setSelectedTeeth([]);
      setUseFlatRate(false); // Reset flat rate after treatment
    } catch (err: any) {
      alert(err.message);
      throw err;
    }
  };

  const handleUndoTreatment = async (record: ClinicalRecord) => {
    if (!selectedPatient) return;
    
    try {
      const res = await api.treatments.undoRecord(record.id);
      
      setSelectedPatient({
        ...selectedPatient,
        balance: Number(res.new_balance),
        loyalty_points: Number(res.new_points)
      });
      setTreatmentHistory((current) => removeTreatmentRecordById(current, record.id));
      setLatestTreatmentBatch((current) => removeTreatmentRecordById(current, record.id));
      setPaymentDraft((current) => ({
        ...current,
        treatments: current.treatments.filter((treatment) => treatment.id !== record.id)
      }));
      setSelectedTreatmentsForReceipt((current) => removeTreatmentRecordById(current, record.id));

      const reversedSaleIds = new Set<string>(res.reversed_medicine_sale_ids || []);
      if (reversedSaleIds.size > 0) {
        setMedicineSales(prev => prev.filter(sale => !reversedSaleIds.has(sale.id)));
        setPatientMedicineSales(prev => prev.filter(sale => !reversedSaleIds.has(sale.id)));
        setAssistantMedicineSales(prev => prev.filter(sale => !reversedSaleIds.has(sale.id)));
      }

      const stockByMedicineId = new Map<string, number>(
        (res.restocked_medicines || []).map((item: any) => [item.medicine_id, Number(item.new_stock)])
      );
      if (stockByMedicineId.size > 0) {
        const applyRestockedQuantities = (rows: Medicine[]) => rows.map(medicine => (
          stockByMedicineId.has(medicine.id)
            ? { ...medicine, stock: stockByMedicineId.get(medicine.id)! }
            : medicine
        ));
        setMedicines(applyRestockedQuantities);
        setAssistantMedicines(applyRestockedQuantities);
      }

      if (res.loyalty_reversal) {
        setLoyaltyTransactions(prev => [res.loyalty_reversal, ...prev]);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUndoMedicineSale = async (sale: MedicineSale) => {
    if (!selectedPatient || sale.patient_id !== selectedPatient.id) {
      throw new Error('The selected patient changed. Reopen the medicine record and try again.');
    }

    try {
      const result = await api.medicines.undoSale(sale.id);
      const updatePatient = (patient: Patient) => patient.id === result.patient_id ? { ...patient, balance: result.new_balance, loyalty_points: result.new_points } : patient;
      const removeSale = (candidate: MedicineSale) => candidate.id !== result.medicine_sale_id;
      const updateStock = (medicine: Medicine) => medicine.id === result.medicine_id ? { ...medicine, stock: result.new_stock } : medicine;

      setSelectedPatient((previous) => previous?.id === result.patient_id ? updatePatient(previous) : previous);
      setPatients((previous) => previous.map(updatePatient));
      setDashboardPatients((previous) => previous.map(updatePatient));
      setAssistantPatients((previous) => previous.map(updatePatient));
      setMedicineSales((previous) => previous.filter(removeSale));
      setPatientMedicineSales((previous) => previous.filter(removeSale));
      setAssistantMedicineSales((previous) => previous.filter(removeSale));
      setMedicines((previous) => previous.map(updateStock));
      setAssistantMedicines((previous) => previous.map(updateStock));
      if (result.loyalty_reversal) {
        setLoyaltyTransactions((previous) => [result.loyalty_reversal!, ...previous]);
      }
      api.medicines.getTopSelling(currentLocationId || sale.location_id, 10)
        .then(setTopSellingMedicines)
        .catch((refreshError) => console.warn('Medicine record was undone, but top-selling inventory could not be refreshed:', refreshError));
      setToast({
        message: `${sale.medicine_name || 'Medicine record'} deleted. Stock and patient balance were restored.`,
        type: 'success',
        show: true
      });
    } catch (err: any) {
      alert(err?.message || 'Medicine record could not be deleted.');
      throw err;
    }
  };

  const handleAddMedicines = () => {
    if (!selectedPatient) return;
    setShowMedicineSelectionModal(true);
  };

  const handleMedicineSelectionConfirm = async (selectedMedicines: SelectedMedicineCharge[]) => {
    if (!selectedPatient) return;
    const salePatient = selectedPatient;
    const salePatientRequestId = medicineHistoryRequestRef.current;
    const saleLocationId = currentLocationId || salePatient.location_id;
    let successfulSaleCount = 0;
    
    if (selectedMedicines.length === 0) {
      setShowMedicineSelectionModal(false);
      return;
    }
    
    setShowMedicineSelectionModal(false);
    
    const medicineCost = selectedMedicines.reduce((sum, item) => sum + item.finalTotal, 0);
    
    try {
      // Record medicine sales
      for (const item of selectedMedicines) {
        await api.medicines.sell(
          salePatient.id,
          item.medicine.id,
          item.quantity,
          saleLocationId,
          undefined,
          item.finalTotal
        );
        successfulSaleCount += 1;
      }

      // Update patient balance (medicines already updated it in the sell function)
      const { data: patient } = await supabase
        .from('patients')
        .select('balance')
        .eq('id', salePatient.id)
        .single();

      if (patient && salePatientRequestId === medicineHistoryRequestRef.current) {
        setSelectedPatient({ ...salePatient, balance: patient.balance });
      }
      
      // Refresh medicines to update stock
      await Promise.all([
        safeLoad('Refresh medicines after inventory sale', fetchMedicines(), undefined),
        safeLoad('Refresh medicine sales after inventory sale', fetchMedicineSales(), undefined)
      ]);

      if (salePatientRequestId === medicineHistoryRequestRef.current) {
        const medicineRequestId = ++medicineHistoryRequestRef.current;
        setPatientMedicineHistoryLoading(true);
        setPatientMedicineHistoryError(null);
        try {
          const refreshedPatientSales = await api.medicines.getSales(
            salePatient.location_id || saleLocationId,
            salePatient.id,
            { throwOnError: true }
          );
          if (medicineRequestId === medicineHistoryRequestRef.current) {
            setPatientMedicineSales(refreshedPatientSales);
            setPatientMedicineHistoryLoading(false);
          }
        } catch (historyError: any) {
          if (medicineRequestId === medicineHistoryRequestRef.current) {
            setPatientMedicineHistoryLoading(false);
            setPatientMedicineHistoryError(historyError?.message || 'The sale was saved, but medicine history could not be refreshed.');
          }
        }
      }
      
      // Show success message
      setToast({
        message: `Successfully added ${selectedMedicines.length} inventory item(s) to patient's bill. Total: ${formatCurrency(medicineCost, currency)}`,
        type: 'success',
        show: true
      });
    } catch (err: any) {
      if (successfulSaleCount > 0) {
        await Promise.all([
          safeLoad('Reconcile medicines after partial inventory sale', fetchMedicines(), undefined),
          safeLoad('Reconcile medicine sales after partial inventory sale', fetchMedicineSales(), undefined)
        ]);

        if (salePatientRequestId === medicineHistoryRequestRef.current) {
          try {
            const [refreshedPatientSales, balanceResult] = await Promise.all([
              api.medicines.getSales(salePatient.location_id || saleLocationId, salePatient.id, { throwOnError: true }),
              supabase.from('patients').select('balance').eq('id', salePatient.id).single()
            ]);
            if (salePatientRequestId === medicineHistoryRequestRef.current) {
              setPatientMedicineSales(refreshedPatientSales);
              setPatientMedicineHistoryLoading(false);
              if (balanceResult.data) {
                setSelectedPatient({ ...salePatient, balance: balanceResult.data.balance });
              }
            }
          } catch (refreshError: any) {
            if (salePatientRequestId === medicineHistoryRequestRef.current) {
              setPatientMedicineHistoryLoading(false);
              setPatientMedicineHistoryError(refreshError?.message || 'Some items were saved, but medicine history could not be refreshed.');
            }
          }
        }
      }
      alert(err.message);
    }
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (paymentSubmitInFlightRef.current || isSubmitting) return;
    if (!selectedPatient) return;
    if (paymentOriginalAmount <= 0) {
      alert('This patient does not have an outstanding balance to collect.');
      return;
    }
    if (paymentAmountTendered <= 0) {
      alert('Amount tendered must be greater than 0.');
      return;
    }
    if (paymentAllocationError) {
      alert(paymentAllocationError);
      return;
    }
    paymentSubmitInFlightRef.current = true;
    setIsSubmitting(true);
    try {
      const session = auth.getSession();
      const paymentDate = toLocalISODate(new Date());
      const submissionKey = paymentSubmissionKeyRef.current || createPaymentSubmissionKey();
      paymentSubmissionKeyRef.current = submissionKey;
      const matchedMedicineSales = getUncapturedMedicineSalesForReceipt(
        medicineSales,
        paymentRecords,
        selectedPatient.id,
        selectedPaymentTreatments,
        paymentDate
      );
      const authoritativeTreatmentHistory = selectedPaymentTreatments.length > 0
        ? await api.treatments.getHistory(selectedPatient.id)
        : [];
      const authoritativePaymentTreatments = validateAuthoritativePaymentTreatments(
        selectedPaymentTreatments,
        authoritativeTreatmentHistory,
        selectedPatient.id,
        selectedPatient.location_id || currentLocationId
      );
      const provisionalReceiptSnapshot = buildPaymentReceiptSnapshot({
        patient: selectedPatient,
        amountPaid: paymentAmountTendered,
        paymentMethod: getPaymentHeaderMethod(effectivePaymentAllocations),
        allocations: effectivePaymentAllocations,
        paymentDate,
        receiptNumber: 'PENDING',
        balanceBefore: paymentOriginalAmount,
        balanceAfter: Math.max(0, paymentOriginalAmount - paymentAmountTendered),
        paymentStatus: paymentAmountTendered >= paymentOriginalAmount ? 'FULL' : 'PARTIAL',
        recordedByUserName: currentUser || session?.username || null,
        serviceFeeAmount: paymentServiceFeeAmount,
        serviceFeeCategory: paymentDraft.serviceFeeCategory,
        treatments: authoritativePaymentTreatments,
        medicines: matchedMedicineSales,
        clinic: { appName, receiptHeaderTitle, receiptInfo, currency }
      });
      const res = await api.finance.processPayment({
        patientId: selectedPatient.id,
        amount: paymentAmountTendered,
        paymentMethod: getPaymentHeaderMethod(effectivePaymentAllocations),
        allocations: effectivePaymentAllocations,
        treatmentIds: authoritativePaymentTreatments.map((treatment) => treatment.id),
        paymentDate,
        submissionKey,
        receiptSnapshot: provisionalReceiptSnapshot,
        createdByUserId: null,
        createdByUserName: currentUser || session?.username || null
      });
      let paymentRecord: PaymentRecord = {
        ...res.payment,
        patient_name: res.payment.patient_name || selectedPatient.name
      };
      const paymentSnapshot = buildPaymentReceiptSnapshot({
        patient: selectedPatient,
        amountPaid: paymentRecord.amount,
        paymentMethod: paymentRecord.paymentMethod || getPaymentHeaderMethod(effectivePaymentAllocations),
        allocations: paymentRecord.allocations || effectivePaymentAllocations,
        paymentDate: paymentRecord.date || paymentDate,
        receiptNumber: paymentRecord.receiptNumber || '',
        balanceBefore: paymentRecord.balanceBefore ?? paymentOriginalAmount,
        balanceAfter: paymentRecord.remainingBalance,
        paymentStatus: paymentRecord.type,
        createdAt: paymentRecord.createdAt || null,
        recordedByUserName: paymentRecord.createdByUserName || currentUser || session?.username || null,
        serviceFeeAmount: paymentServiceFeeAmount,
        serviceFeeCategory: paymentDraft.serviceFeeCategory,
        treatments: authoritativePaymentTreatments,
        medicines: matchedMedicineSales,
        clinic: {
          appName,
          receiptHeaderTitle,
          receiptInfo,
          currency
        }
      });

      try {
        const savedSnapshot = await api.finance.saveReceiptSnapshot(paymentRecord.id, paymentSnapshot);
        paymentRecord = {
          ...paymentRecord,
          receiptSnapshot: savedSnapshot
        };
      } catch (snapshotError) {
        console.warn('Failed to persist payment receipt snapshot:', snapshotError);
        paymentRecord = {
          ...paymentRecord,
          receiptSnapshot: paymentSnapshot
        };
      }

      const shouldIncludeInCurrentScope =
        dashboardLocationId === ALL_BRANCHES_VALUE || dashboardLocationId === selectedPatient.location_id;
      if (shouldIncludeInCurrentScope) {
        setDashboardPayments((prev) => [paymentRecord, ...prev]);
      }
      setPaymentRecords((prev) => [paymentRecord, ...prev]);
      setPatientPaymentRecords((prev) => [paymentRecord, ...prev]);
      setAssistantPaymentRecords((prev) => [paymentRecord, ...prev]);

      setSelectedPatient({ ...selectedPatient, balance: res.new_balance });
      setLatestTreatmentBatch((records) => removePatientTreatmentRecords(records, selectedPatient.id));
      setLastPaymentAmount(paymentAmountTendered);
      setLastPaymentRecord(paymentRecord);
      setReceiptViewerPatient(null);
      setActivePaymentReceiptSnapshot(null);
      setSelectedTreatmentsForReceipt([]);
      setSelectedMedicineSalesForReceipt([]);
      setShowPaymentModal(false);
      paymentSubmitInFlightRef.current = false;
      paymentSubmissionKeyRef.current = null;
      setPaymentDraft({ treatments: [], amountTendered: 0, previousBalance: 0, currentTreatmentTotal: 0, serviceFeeAmount: 0, serviceFeeCategory: null, paymentMethod: 'UNKNOWN', splitPayment: false, allocations: [] });
      // Ask whether to generate a receipt after posting payment.
      setShowReceiptPrompt(true);
      fetchInitialData(); 
    } catch (err: any) {
      paymentSubmitInFlightRef.current = false;
      alert(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReceiptPromptYes = () => {
    if (!lastPaymentRecord) return;
    const snapshot = resolvePaymentReceiptSnapshotForViewer(lastPaymentRecord);
    setShowReceiptPrompt(false);
    setReceiptViewerPatient(
      selectedPatient || {
        id: lastPaymentRecord.patientId,
        patient_unique_id: snapshot.patient.patientUniqueId || '',
        location_id: lastPaymentRecord.location_id || '',
        name: snapshot.patient.name || lastPaymentRecord.patient_name || 'Unknown Patient',
        email: snapshot.patient.email || '',
        phone: snapshot.patient.phone || '',
        balance: lastPaymentRecord.remainingBalance,
        loyalty_points: 0
      }
    );
    setActivePaymentReceiptSnapshot(snapshot);
    setSelectedTreatmentsForReceipt([]);
    setSelectedMedicineSalesForReceipt([]);
    setShowReceipt(true);
  };

  const handleReceiptPromptNo = () => {
    setShowReceiptPrompt(false);
    setReceiptViewerPatient(null);
    setActivePaymentReceiptSnapshot(null);
    setSelectedTreatmentsForReceipt([]);
    setSelectedMedicineSalesForReceipt([]);
    setLastPaymentAmount(0);
    setLastPaymentRecord(null);
  };

  const handleGenerateReceipt = () => {
    setLastPaymentAmount(0);
    setLastPaymentRecord(null);
    setReceiptViewerPatient(null);
    setActivePaymentReceiptSnapshot(null);
    setSelectedTreatmentsForReceipt([]);
    setSelectedMedicineSalesForReceipt([]);
    setShowTreatmentSelection(true);
  };

  const handleViewAppointmentChart = (appointment: Appointment) => {
    const patient = patients.find((item) => item.id === appointment.patient_id);
    if (!patient) {
      setToast({
        message: 'Patient chart is not available for this appointment.',
        type: 'error',
        show: true
      });
      return;
    }

    handlePatientSelect(patient);
  };

  const handleEditAppointmentPatientInfo = (appointment: Appointment) => {
    const patient = patients.find((item) => item.id === appointment.patient_id);
    if (!patient) {
      setToast({
        message: 'Patient profile is not available for this appointment.',
        type: 'error',
        show: true
      });
      return;
    }

    if (!canAccessView('patients')) {
      setToast({
        message: 'You do not have permission to edit patient profiles.',
        type: 'error',
        show: true
      });
      return;
    }

    setPatientToEditFromAppointment(patient);
    setCurrentView('patients');
    setIsMobileMenuOpen(false);
  };

  const handleConvertLeadAppointment = (appointment: Appointment) => {
    setConvertingLeadAppointment(appointment);
    setShowPatientCreationDate(false);
    setPatientCreationDate(toLocalDateInputValue());
    setNewPatientData({
      name: appointment.guest_name || appointment.patient_name || '',
      email: '',
      phone: appointment.guest_phone || '',
      medicalHistory: appointment.guest_notes || '',
      password: '',
      age: undefined,
      address: '',
      city: '',
      township: '',
      patient_type: mapLeadSourceToPatientType(appointment.guest_source, activePatientTypeOptions),
      location_id: currentLocationId || ''
    });
    setShowAppointmentModal(false);
    setEditingAppointment(null);
    setShowPatientModal(true);
  };

  const handleTreatmentSelectionConfirm = (selectedTreatments: ClinicalRecord[], selectedMedicines: MedicineSale[]) => {
    setSelectedTreatmentsForReceipt(selectedTreatments);
    setSelectedMedicineSalesForReceipt(selectedMedicines);
    setReceiptViewerPatient(selectedPatient);
    setActivePaymentReceiptSnapshot(null);
    setShowTreatmentSelection(false);
    setShowReceipt(true);
  };

  const handleUploadFiles = async (files: FileList | File[]) => {
    if (!selectedPatient) return;
    const uploadList = Array.from(files);
    if (uploadList.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(uploadList.map(f => api.files.upload(selectedPatient.id, f)));
      setPatientFiles(prev => [...uploaded, ...prev]);
    } catch (err: any) {
      alert(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFilesWithProgress = async (
    files: File[],
    onProgress: (progress: { fileName: string; bytesUploaded: number; bytesTotal: number; percentage: number }) => void
  ): Promise<void> => {
    if (!selectedPatient) return;
    if (files.length === 0) return;

    setUploading(true);
    try {
      // Log smart upload configuration
      console.log(`[Upload Handler] Uploading ${files.length} file(s) with smart chunking`);
      
      // Upload files sequentially to show proper progress for each
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
        const chunkSizeMB = (api.files.calculateOptimalChunkSize(file.size) / 1024 / 1024).toFixed(2);
        
        console.log(`[Upload Handler] File ${i + 1}/${files.length}: ${file.name} (${fileSizeMB}MB, chunks: ${chunkSizeMB}MB)`);
        
        await api.files.uploadWithTus(
          selectedPatient.id,
          file,
          (bytesUploaded, bytesTotal) => {
            const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
            onProgress({
              fileName: file.name,
              bytesUploaded,
              bytesTotal,
              percentage
            });
          },
          (chunkSize, bytesAccepted, bytesTotal) => {
            // Log chunk completion for debugging
            console.log(`[Upload Handler] Chunk uploaded: ${(chunkSize / 1024 / 1024).toFixed(2)}MB`);
          }
        );
        
        console.log(`[Upload Handler] Completed file ${i + 1}/${files.length}: ${file.name}`);
      }

      // Refresh the file list after upload
      const updatedFiles = await api.files.list(selectedPatient.id);
      setPatientFiles(updatedFiles);
      
      console.log(`[Upload Handler] All ${files.length} file(s) uploaded successfully`);
    } catch (err: any) {
      console.error('[Upload Handler] Upload failed:', err);
      alert(err.message || 'Upload failed');
      throw err;
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteFile = async (path: string) => {
    if (!selectedPatient) return;
    try {
      await api.files.remove(path);
      setPatientFiles(prev => prev.filter(f => f.path !== path));
    } catch (err: any) {
      alert(err.message || 'Failed to delete file');
    }
  };

  const handleClosePatient = () => {
    treatmentHistoryRequestRef.current += 1;
    medicineHistoryRequestRef.current += 1;
    paymentHistoryRequestRef.current += 1;
    setLatestTreatmentBatch([]);
    setPaymentDraft({ treatments: [], amountTendered: 0, previousBalance: 0, currentTreatmentTotal: 0, serviceFeeAmount: 0, serviceFeeCategory: null, paymentMethod: 'UNKNOWN', splitPayment: false, allocations: [] });
    setSelectedPatient(null);
    setPatientMedicineSales([]);
    setPatientMedicineHistoryLoading(false);
    setPatientMedicineHistoryError(null);
    setTreatmentHistoryLoading(false);
    setPatientPaymentRecords([]);
    setPatientPaymentHistoryLoading(false);
    setPatientPaymentHistoryError(null);
    setSelectedDoctorId('');
    setSelectedTeeth([]);
    setTreatmentHistory([]);
    setPatientFiles([]);
    setUseFlatRate(false); // Reset flat rate when closing patient
  };

  const renderAppBrand = (variant: 'mobile' | 'sidebar') => {
    if (appLogoUrl) {
      return (
        <img
          src={appLogoUrl}
          alt="Clinic logo"
          className={variant === 'mobile'
            ? 'max-h-12 max-w-[200px] object-contain'
            : 'max-h-[6.25rem] max-w-full object-contain'
          }
        />
      );
    }

    if (!appName) {
      return null;
    }

    return (
      <span className={`${variant === 'mobile' ? 'text-lg' : 'text-xl text-center'} font-black tracking-tight bg-gradient-to-r from-indigo-300 via-purple-300 to-pink-300 bg-clip-text text-transparent`}>
        {appName}
      </span>
    );
  };

  // Password recovery must stay on the login/reset screen even if this device
  // still has an older local auth session saved.
  if (isRecoveryFlowActive()) {
    return (
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <Loader2 className="animate-spin text-indigo-600 w-10 h-10" />
        </div>
      }>
        <LoginView onLoginSuccess={handleLoginSuccess} appName={appName} appLogoUrl={appLogoUrl} />
      </Suspense>
    );
  }

  // Show patient dashboard if patient is logged in
  if (isAuthenticated && auth.isPatient()) {
    return (
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <Loader2 className="animate-spin text-indigo-600 w-10 h-10" />
        </div>
      }>
        <PatientDashboardView onLogout={handleLogout} messagingEnabled={messagingEnabled} hoverTheme={hoverTheme} />
      </Suspense>
    );
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return (
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <Loader2 className="animate-spin text-indigo-600 w-10 h-10" />
        </div>
      }>
        <LoginView onLoginSuccess={handleLoginSuccess} appName={appName} appLogoUrl={appLogoUrl} />
      </Suspense>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white p-8 rounded-2xl shadow-xl text-center border border-red-100">
          <Activity className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Connection Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button onClick={() => fetchInitialData()} className="w-full bg-indigo-600 text-white py-2 rounded-lg font-medium hover:bg-indigo-700">
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const session = auth.getSession();
  const canAdminViewAllBranches = !!(session?.role === 'admin' && !session?.location_id);
  const currentDoctor = isDoctor && session?.doctor_id
    ? doctors.find((doctor) => doctor.id === session.doctor_id) || null
    : null;
  const currentDoctorLocationIds = currentDoctor
    ? Array.from(new Set([...(currentDoctor.location_ids || []), currentDoctor.location_id].filter(Boolean)))
    : [];
  const shouldShowAdminBadge = isAdmin && currentUser.trim().toLowerCase() !== 'admin';
  const isWorkspaceView = currentView === 'ai-assistant' || currentView === 'messaging' || currentView === 'patients' || currentView === 'appointments';
  const editableAllowedTabs = resolveAllowedTabs('normal', newUserData.allowed_tabs).filter((tab) => (
    tab !== 'branch-switching' || !newUserData.location_id
  )) as ViewState[];
  const doctorMobileTabs: { key: ViewState; label: string; icon: React.ReactNode; isActive: boolean }[] = [
    {
      key: 'dashboard',
      label: 'Home',
      icon: <Home size={18} />,
      isActive: doctorActiveTab === 'dashboard'
    },
    {
      key: 'appointments',
      label: 'Appointments',
      icon: <Calendar size={18} />,
      isActive: doctorActiveTab === 'appointments'
    },
    {
      key: 'records',
      label: 'Records',
      icon: <ClipboardList size={18} />,
      isActive: doctorActiveTab === 'records'
    },
    {
      key: 'settings',
      label: 'Profile',
      icon: <Settings size={18} />,
      isActive: doctorActiveTab === 'settings'
    }
  ];
  const doctorViewTitle = 'Doctor Dashboard';
  return (
    <div className={isDoctor ? "min-h-screen bg-gray-50 flex flex-col" : "min-h-screen flex bg-gray-50 flex-col lg:flex-row"}>
      {/* Toast Notification */}
      {toast.show && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast({ ...toast, show: false })}
        />
      )}

      {isDoctor && (
        <header className="bg-white shadow-sm border-b border-gray-200 px-4 pt-6 pb-3 sticky top-0 z-40">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-gray-900 truncate">{doctorViewTitle}</h1>
              <p className="text-xs text-gray-500 truncate">{currentUser}</p>
            </div>
            <div className="flex items-center gap-2">
              {currentView === 'finance' && (
                <button
                  onClick={() => setCurrentView('appointments')}
                  className="px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 transition-colors"
                >
                  Back
                </button>
              )}
              <button
                onClick={() => { void handleLogout(); }}
                disabled={isLoggingOut}
                className="p-2 rounded-full bg-red-100 hover:bg-red-200 transition-colors disabled:opacity-60"
                aria-label="Logout"
              >
                {isLoggingOut ? <Loader2 className="w-4 h-4 text-red-600 animate-spin" /> : <LogOut className="w-4 h-4 text-red-600" />}
              </button>
            </div>
          </div>
        </header>
      )}
      
      {/* Mobile Header */}
      {!isDoctor && (
      <header className="lg:hidden theme-nav-bg theme-nav-text p-4 flex items-center justify-between sticky top-0 z-50">
        {renderAppBrand('mobile')}
        <button 
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="p-2 theme-nav-soft rounded-lg transition-colors"
        >
          {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </header>
      )}

      {/* Mobile Overlay */}
      {!isDoctor && isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar Navigation */}
      {!isDoctor && (
      <aside 
        style={{ width: isCompactScreen ? 'min(82vw, 320px)' : `${sidebarWidth}px` }}
        className={`theme-nav-bg fixed lg:sticky top-0 h-screen z-50 lg:z-40 border-r theme-nav-border flex flex-col overflow-hidden transition-transform duration-300 lg:translate-x-0 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="p-8 flex items-center justify-center flex-shrink-0">
          {renderAppBrand('sidebar')}
        </div>
        
        <nav className="sidebar-scrollbar mt-2 px-6 space-y-2 flex-1 min-h-0 overflow-y-auto overscroll-contain pb-4">
          {canAccessView('dashboard') && <NavItem icon={<LayoutDashboard size={18} />} label="Overview" active={currentView === 'dashboard'} onClick={() => { setCurrentView('dashboard'); setIsMobileMenuOpen(false); }} />}
          {canAccessView('patients') && <NavItem icon={<Users size={18} />} label="Patients" active={currentView === 'patients'} onClick={() => { setCurrentView('patients'); setIsMobileMenuOpen(false); }} />}
          {canAccessView('appointments') && <NavItem icon={<Calendar size={18} />} label="Appointments" active={currentView === 'appointments'} onClick={() => { setCurrentView('appointments'); setIsMobileMenuOpen(false); }} />}
          {canAccessView('doctors') && <NavItem icon={<UserCheck size={18} />} label="Doctors" active={currentView === 'doctors'} onClick={() => { setCurrentView('doctors'); setIsMobileMenuOpen(false); }} />}
          
          <div className="pt-8 pb-2">
             <p className="px-3 text-[10px] font-black theme-nav-muted uppercase tracking-[0.2em] mb-4">Operations</p>
             {canAccessView('treatments') && (
               <NavItem icon={<Stethoscope size={18} />} label="Service Menu" active={currentView === 'treatments'} onClick={() => { setCurrentView('treatments'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('material-cost') && (
                <NavItem icon={<Package size={18} />} label="MLS" active={currentView === 'material-cost'} onClick={() => { setCurrentView('material-cost'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('records') && (
               <NavItem icon={<ClipboardList size={18} />} label={isDoctor ? 'Patient Records' : 'Audit Log'} active={currentView === 'records'} onClick={() => { setRecordsInitialFilter('all'); setCurrentView('records'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('finance') && <NavItem icon={<CreditCard size={18} />} label="Clinical Focus" active={currentView === 'finance'} onClick={() => { setCurrentView('finance'); setIsMobileMenuOpen(false); }} />}
             {canAccessView('expenses') && (
               <NavItem icon={<DollarSign size={18} />} label="Expenses" active={currentView === 'expenses'} onClick={() => { setCurrentView('expenses'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('inventory') && (
               <NavItem icon={<Package size={18} />} label="Inventory" active={currentView === 'inventory'} onClick={() => { setCurrentView('inventory'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('messaging') && (
               <NavItem icon={<MessageCircle size={18} />} label={isDoctor ? 'Admin Chat' : 'Messaging'} active={currentView === 'messaging'} onClick={() => { setCurrentView('messaging'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('ai-assistant') && <NavItem icon={<Sparkles size={18} />} label="AI Assistant" active={currentView === 'ai-assistant'} onClick={() => { setCurrentView('ai-assistant'); setIsMobileMenuOpen(false); }} />}
          </div>
          
          <div className="pt-8 pb-2">
             <p className="px-3 text-[10px] font-black theme-nav-muted uppercase tracking-[0.2em] mb-4">System</p>
             {canAccessView('users') && (
               <NavItem icon={<Shield size={18} />} label="Users" active={currentView === 'users'} onClick={() => { setCurrentView('users'); setIsMobileMenuOpen(false); }} />
             )}
             {canAccessView('settings') && (
               <NavItem icon={<Settings size={18} />} label={isDoctor ? 'Profile' : 'Settings'} active={currentView === 'settings'} onClick={() => { setCurrentView('settings'); setIsMobileMenuOpen(false); }} />
             )}
             {!isAdmin && !isDoctor && canAccessView('branch-switching') && (
               <NavItem icon={<MapPin size={18} />} label="Change Branch" active={currentView === 'branch-switching'} onClick={() => { setCurrentView('branch-switching'); setIsMobileMenuOpen(false); }} />
             )}
          </div>
        </nav>

        <div className="p-8 pt-4 flex-shrink-0 border-t theme-nav-border">
           <div className="p-4 theme-nav-soft rounded-2xl border theme-nav-border">
              <p className="text-[10px] theme-nav-muted font-bold uppercase tracking-wider mb-2">Logged in as</p>
              <div className="flex items-center justify-between">
                 <span className="text-xs theme-nav-text font-medium">{currentUser}</span>
                 {shouldShowAdminBadge && (
                   <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300 uppercase">Admin</span>
                 )}
              </div>
              <button
                onClick={() => { void handleLogout(); }}
                disabled={isLoggingOut}
                className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 theme-nav-bg hover:opacity-90 theme-nav-text rounded-lg text-xs font-medium transition-colors disabled:opacity-60"
              >
                {isLoggingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
                {isLoggingOut ? 'Logging out...' : 'Logout'}
              </button>
           </div>
        </div>
        
        {/* Resize Handle */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute top-0 right-0 hidden h-full w-1 cursor-col-resize transition-colors hover:bg-indigo-500 lg:block z-30"
          style={{ 
            backgroundColor: isResizing ? '#6366f1' : 'transparent'
          }}
        />
      </aside>
      )}

      <main className={isDoctor ? "flex min-w-0 flex-1 flex-col p-0 pb-32" : isWorkspaceView ? "flex min-w-0 flex-1 flex-col p-0 lg:h-screen overflow-hidden" : "flex-1 min-w-0 p-3 md:p-5"}>
        <div className={isDoctor || isWorkspaceView ? "flex min-h-0 flex-1 flex-col" : "w-full"}>
          <Suspense fallback={<div className="flex justify-center p-20"><Loader2 className="animate-spin text-indigo-600 w-10 h-10" /></div>}>
            {currentView === 'dashboard' && canAccessView('dashboard') && (
              isDoctor ? (
                <DoctorHomeView
                  appointments={appointments}
                  treatmentRecords={globalRecords}
                  patients={patients}
                  locations={locations}
                  activeLocationIds={currentDoctorLocationIds}
                  onLoadTreatmentCostSummaries={api.materialCosts.getTotalsByTreatmentIds}
                  onSelectPatient={handlePatientSelect}
                  onOpenAppointmentsForDate={handleOpenDoctorAppointmentsForDate}
                />
              ) : (
                <DashboardView
                  patients={dashboardPatients}
                  appointments={dashboardAppointments}
                  treatmentRecords={dashboardRecords}
                  expenses={dashboardExpenses}
                  paymentRecords={dashboardPayments}
                  currency={currency}
                  locations={locations}
                  selectedLocationId={dashboardLocationId}
                  allBranchesValue={ALL_BRANCHES_VALUE}
                  canViewAllBranches={canAdminViewAllBranches}
                  onLocationChange={handleDashboardLocationChange}
                  onUpdateCancellationOutcome={handleUpdateCancellationOutcome}
                  onLoadTreatmentAnalysis={async (dateFrom, dateTo) => {
                    const session = auth.getSession();
                    const restrictedLocationId = getSessionRestrictedLocationId(session);
                    const queryLocationId = restrictedLocationId || (dashboardLocationId === ALL_BRANCHES_VALUE ? undefined : dashboardLocationId);
                    return api.treatments.getAnalysisRecords({ locationId: queryLocationId, dateFrom, dateTo });
                  }}
                  onLoadMonthlyReport={async (dateFrom, dateTo, onProgress) => {
                    const session = auth.getSession();
                    const restrictedLocationId = getSessionRestrictedLocationId(session);
                    const queryLocationId = restrictedLocationId || (dashboardLocationId === ALL_BRANCHES_VALUE ? undefined : dashboardLocationId);
                    onProgress({ percent: 8, label: 'Loading treatments…' });
                    const { records, allocationRecords } = await api.treatments.getMonthlyReportRecords({
                      locationId: queryLocationId,
                      dateFrom,
                      dateTo,
                      onProgress: (completed, total) => onProgress({
                        percent: 8 + Math.round((completed / Math.max(total, 1)) * 35),
                        label: `Loading treatment history ${completed}/${total}…`
                      })
                    });
                    onProgress({ percent: 45, label: 'Treatment history loaded' });
                    const patientIds = Array.from(new Set(records.map(record => record.patient_id).filter(Boolean)));
                    const [payments, costSummaries] = await Promise.all([
                      api.finance.getMonthlyReportPayments({
                        locationId: queryLocationId,
                        dateTo,
                        patientIds,
                        onProgress: (completed, total) => onProgress({
                          percent: 45 + Math.round((completed / Math.max(total, 1)) * 20),
                          label: `Loading payments ${completed}/${total}…`
                        })
                      }),
                      api.materialCosts.getTotalsByTreatmentIds(records.map(record => record.id), {
                        requireCostTables: true,
                        onProgress: (completed, total) => onProgress({
                          percent: 45 + Math.round((completed / Math.max(total, 1)) * 38),
                          label: `Loading treatment costs ${completed}/${total}…`
                        })
                      })
                    ]);
                    onProgress({ percent: 86, label: 'Calculating balances and profit…' });
                    const { buildMonthlyReport } = await import('./utils/monthlyReport');
                    const report = buildMonthlyReport({ records, allocationRecords, payments, costSummaries });
                    onProgress({ percent: 92, label: 'Report calculations complete' });
                    return report;
                  }}
                  onSelectPatient={handlePatientSelect}
                  loading={loading}
                />
              )
            )}
            {currentView === 'patients' && canAccessView('patients') && <PatientsView 
                patients={patients} 
                patientTypes={patientTypes}
                locations={locations}
                appointments={appointments}
                loading={loading} 
                currency={currency} 
                onRefresh={async () => { await fetchInitialData(currentLocationId || undefined); }}
                loyaltyEnabled={loyaltyEnabled} 
                loyaltyRules={loyaltyRules}
                doctors={doctors}
                treatmentTypes={treatmentTypes}
                treatmentRecords={globalRecords}
                onSelectPatient={handlePatientSelect} 
                onAddPatient={() => {
                  setNewPatientData({
                    name: '',
                    email: '',
                    phone: '',
                    medicalHistory: '',
                    password: '',
                    age: undefined,
                    address: '',
                    city: '',
                    township: '',
                    patient_type: activePatientTypeOptions[0] || DEFAULT_PATIENT_TYPE_NAME,
                    location_id: currentLocationId || ''
                  });
                  setShowPatientCreationDate(false);
                  setPatientCreationDate(toLocalDateInputValue());
                  setShowPatientModal(true);
                }}
                onExportPDF={async () => {
                   const [freshPatients, freshTreatmentRecords] = await Promise.all([
                     api.patients.getAll(currentLocationId || undefined),
                     api.treatments.getAllRecords(currentLocationId || undefined)
                   ]);
                   const { exportPatientsToPDF } = await import('./utils/pdfExport');
                    exportPatientsToPDF(freshPatients, currency, freshTreatmentRecords);
                }}
                onExportExcel={async () => {
                   const [freshPatients, freshTreatmentRecords] = await Promise.all([
                     api.patients.getAll(currentLocationId || undefined),
                     api.treatments.getAllRecords(currentLocationId || undefined)
                   ]);
                   const { exportPatientsToExcel } = await import('./utils/excelExport');
                    await exportPatientsToExcel(freshPatients, currency, freshTreatmentRecords);
                }}
                onUpdatePatient={async (id, data) => {
                  try {
                    await api.patients.update(id, data);
                    fetchInitialData(currentLocationId || undefined);
                    setToast({ show: true, message: 'Patient profile updated successfully.', type: 'success' });
                  } catch (err: any) {
                    if (err?.message?.includes('Cannot transfer branch: Patient has existing records')) {
                      throw err;
                    }
                    setToast({ show: true, message: err?.message || 'Failed to update patient profile.', type: 'error' });
                    throw err;
                  }
                }}
                onDeletePatient={handleDeletePatient}
                onRedeemPoints={(patient, points, amount) => handleRedeemPoints(points, amount, patient)}
                onUpdatePatientAuth={async (patient, password) => {
                  try {
                    await api.patients.updateAccount(patient.id, patient.email || null, password, patient.phone || null);
                    setToast({ show: true, message: 'Patient portal account updated successfully.', type: 'success' });
                    fetchInitialData(); // Refresh to update has_account status
                  } catch (err: any) {
                    setToast({ show: true, message: err?.message || 'Failed to update patient portal account.', type: 'error' });
                    throw err;
                  }
                }}
                onNotify={(message, type) => setToast({ show: true, message, type })}
                patientToEdit={patientToEditFromAppointment}
                onPatientEditHandled={() => setPatientToEditFromAppointment(null)}
            />}
            {currentView === 'appointments' && canAccessView('appointments') && <AppointmentsView
                appointments={appointmentPageAppointments}
                patients={patients}
                doctors={doctors}
                treatmentTypes={treatmentTypes}
                loading={appointmentPageLoading}
                totalAppointments={appointmentPageTotal}
                onQueryChange={loadAppointmentPage}
                onRefresh={() => setAppointmentPageRefreshKey((key) => key + 1)}
                canCorrectDoctor={isAdmin}
                onPreviewDoctorCorrection={async (appointmentId) => {
                  const session = auth.getSession();
                  if (session?.role !== 'admin' || !session.staffAuthToken) {
                    throw new Error('A valid administrator session is required. Sign in again and retry.');
                  }
                  return api.appointments.getDoctorCorrectionPreview(appointmentId, {
                    userId: session.userId,
                    authToken: session.staffAuthToken
                  });
                }}
                onCorrectDoctor={async (input) => {
                  const session = auth.getSession();
                  if (session?.role !== 'admin' || !session.staffAuthToken) {
                    throw new Error('A valid administrator session is required. Sign in again and retry.');
                  }
                  const result = await api.appointments.correctDoctor({
                    ...input,
                    actor: { userId: session.userId, authToken: session.staffAuthToken }
                  });
                  setAppointmentPageRefreshKey((key) => key + 1);
                  setToast({
                    message: `Doctor corrected successfully. ${result.updated_treatment_count} treatment record${result.updated_treatment_count === 1 ? '' : 's'} updated.`,
                    type: 'success',
                    show: true
                  });
                  void fetchInitialData(currentLocationId || undefined).catch((refreshError) => {
                    console.warn('Doctor correction succeeded, but background data refresh failed:', refreshError);
                  });
                  return result;
                }}
                onAddAppointment={() => {setEditingAppointment(null); resetAppointmentForm(); setShowAppointmentModal(true)}} 
                onEditAppointment={(apt) => {
                  const clinicalPlan = parseAppointmentClinicalFocus(apt.notes);
                  setEditingAppointment(apt);
                  setAppointmentPatientMode(apt.patient_id ? 'registered' : 'lead');
                  setNewAppointmentData({
                    date: apt.date,
                    time: apt.time,
                    type: apt.type || '',
                    status: apt.status,
                    patient_id: apt.patient_id || '',
                    doctor_id: apt.doctor_id,
                    location_id: apt.location_id || currentLocationId || '',
                    notes: apt.notes,
                    guest_name: apt.guest_name || '',
                    guest_phone: apt.guest_phone || '',
                    guest_email: '',
                    guest_age: '',
                    guest_address: '',
                    guest_password: '',
                    guest_source: apt.guest_source || '',
                    guest_notes: apt.guest_notes || ''
                  });
                  setDoctorSearchQuery(apt.doctor_name || '');
                  setShowDoctorDropdown(false);
                  setAppointmentClinicalFocus(clinicalPlan.clinicalFocus || apt.type || '');
                  setAppointmentGeneralNotes(clinicalPlan.notes || '');
                  setAppointmentRescheduleReasonPreset('Patient did not arrive');
                  setAppointmentRescheduleReasonCustom('');
                  setShowAppointmentModal(true);
                }} 
                onDeleteAppointment={handleDeleteAppointment} 
                onUpdateStatus={handleUpdateAppointmentStatus} 
                currency={currency}
                onViewChart={handleViewAppointmentChart}
                onSelectPatient={handlePatientSelect}
                onEditPatientInfo={handleEditAppointmentPatientInfo}
                onConvertLead={handleConvertLeadAppointment}
                onOpenAppointmentLog={canAccessView('records') && !isDoctor ? () => {
                  setRecordsInitialFilter('appointments');
                  setCurrentView('records');
                } : undefined}
                canCreate={!isDoctor}
                canEdit={!isDoctor}
                canDelete={!isDoctor}
                canViewChart={true}
                canExport={!isDoctor}
                uiStyle={isDoctor || isCompactScreen ? 'cards' : 'table'}
                initialDateQuickFilter={appointmentsInitialDateQuickFilter}
                onExportPDF={async () => {
                   const freshAppointments = await api.appointments.getAll(currentLocationId || undefined);
                   const { exportAppointmentsToPDF } = await import('./utils/pdfExport');
                   exportAppointmentsToPDF(freshAppointments);
                }}
                onExportExcel={async () => {
                   const freshAppointments = await api.appointments.getAll(currentLocationId || undefined);
                   const { exportAppointmentsToExcel } = await import('./utils/excelExport');
                   await exportAppointmentsToExcel(freshAppointments);
                }}
            />}
            {currentView === 'doctors' && canAccessView('doctors') && <DoctorsView doctors={doctors} loading={loading} currency={currency} onRefresh={async () => { await fetchInitialData(currentLocationId || undefined); }} onAdd={() => {setEditingDoctor(null); setNewDoctorData({ name: '', email: '', phone: '', specialization: 'General', commission_type: 'percentage', password: '', commission_percentage: 0, commission_per_visit: 0, schedules: [], location_id: currentLocationId || '', location_ids: currentLocationId ? [currentLocationId] : [] }); resetDoctorCommissionEditor(); setShowDoctorModal(true)}} onEdit={(doc) => {setEditingDoctor(doc); setNewDoctorData({ ...doc, location_ids: doc.location_ids || [doc.location_id].filter(Boolean), specialization: doc.specialization || 'General', commission_type: resolveDoctorCommissionType({ commissionType: doc.commission_type, specialization: doc.specialization }), password: '' }); resetDoctorCommissionEditor(); setShowDoctorModal(true)}} onDelete={handleDeleteDoctor} />}
            {currentView === 'treatments' && canAccessView('treatments') && <TreatmentConfigView treatmentTypes={treatmentTypes} currency={currency} loading={loading} onRefresh={async () => { await fetchInitialData(currentLocationId || undefined); }} onAdd={() => {setEditingTreatmentType(null); setNewTreatmentTypeData({ name: '', cost: 0, category: '' }); setShowTreatmentTypeModal(true)}} onEdit={(t) => {setEditingTreatmentType(t); setNewTreatmentTypeData(t); setShowTreatmentTypeModal(true)}} onDelete={(id) => { const treatment = treatmentTypes.find(t => t.id === id); if (treatment) { setServiceToDelete({ id: treatment.id, name: treatment.name }); setDeleteServiceConfirmOpen(true); } }} />}
            {currentView === 'material-cost' && canAccessView('material-cost') && <MaterialCostView records={globalRecords} paymentRecords={paymentRecords} loading={loading} currency={currency} canManageMaterials={canManageMaterialCosts(session?.role, session?.allowed_tabs)} onRefresh={async () => { await fetchGlobalRecords(); await fetchExpenses(); await fetchDashboardData(dashboardLocationId === ALL_BRANCHES_VALUE ? undefined : dashboardLocationId); }} onCostsSaved={async (patientId) => { await refreshGlobalRecordsForPatient(patientId); void fetchExpenses(); void fetchDashboardData(dashboardLocationId === ALL_BRANCHES_VALUE ? undefined : dashboardLocationId).catch(() => { console.warn('Dashboard refresh after MLS cost save needs a manual refresh.'); }); }} />}
            {currentView === 'records' && canAccessView('records') && <RecordsView records={auditRecords} patients={patients} appointments={auditAppointments} rescheduleLogs={auditRescheduleLogs} payments={auditPayments} loading={auditLoading} loadError={auditLoadError} onQueryChange={loadAuditLog} onRefresh={() => setAuditRefreshKey((key) => key + 1)} onDeleteAll={isDoctor ? () => alert('Doctor accounts cannot delete patient records.') : handleDeleteAllRecords} currency={currency} isDoctor={isDoctor} initialFilter={recordsInitialFilter} onOpenPaymentReceipt={handleOpenStoredPaymentReceipt} canEditPayments={isAdmin && !isDoctor} onPaymentCorrected={handlePaymentCorrected} />}
            {currentView === 'inventory' && canAccessView('inventory') && <InventoryView medicines={medicines} topSelling={topSellingMedicines} loading={loading} currency={currency} onRefresh={async () => { await fetchInitialData(currentLocationId || undefined); }} onAdd={() => {setEditingMedicine(null); setNewMedicineData({ name: '', description: '', unit: 'pack', item_type: 'Medicine', price: 0, stock: 0, min_stock: 0, quantity_step: 1, category: '' }); setShowMedicineModal(true)}} onEdit={(med) => {setEditingMedicine(med); setNewMedicineData(med); setShowMedicineModal(true)}} onDelete={handleDeleteMedicine} />}
            {currentView === 'expenses' && canAccessView('expenses') && (
              <ExpensesView
                expenses={expenses}
                treatmentRecords={globalRecords}
                medicineSales={medicineSales}
                locations={locations}
                currentLocationId={currentLocationId}
                loading={loading}
                currency={currency}
                onRefresh={async () => { await fetchExpenses(); }}
                onAdd={() => {setEditingExpense(null); setNewExpenseData(getDefaultExpenseFormData()); setShowExpenseModal(true);}}
                onEdit={(expense) => {setEditingExpense(expense); setNewExpenseData({ description: expense.description, amount: expense.amount, category: expense.category, date: expense.date }); setShowExpenseModal(true);}}
                onDelete={handleDeleteExpense}
              />
            )}
            {currentView === 'users' && canAccessView('users') && <UsersView users={users} loading={loading} isAdmin={isAdmin} onRefresh={async () => { await fetchUsers(); }} onAdd={() => {setEditingUser(null); setUserFormError(null); setNewUserData(getDefaultUserFormData()); setShowUserModal(true)}} onEdit={(user) => {setEditingUser(user); setUserFormError(null); setNewUserData({ username: user.username, password: '', role: user.role, location_id: user.location_id, allowed_tabs: resolveAllowedTabs(user.role, user.allowed_tabs) }); setShowUserModal(true)}} onDelete={handleDeleteUser} />}
            {currentView === 'settings' && canAccessView('settings') && (
              isDoctor ? (
                <DoctorProfileView
                  doctor={currentDoctor}
                  loading={loading}
                  onSave={handleUpdateDoctorProfile}
                  hoverTheme={hoverTheme}
                />
              ) : (
                <SettingsView
                    currency={currency}
                    onCurrencyChange={handleCurrencyChange}
                    locations={locations}
                    currentLocationId={currentLocationId}
                    onLocationChange={handleLocationChange}
                    onAddLocation={handleCreateLocation}
                    onUpdateLocation={handleUpdateLocation}
                    onDeleteLocation={handleDeleteLocation}
                    loyaltyRules={loyaltyRules}
                    onUpdateLoyaltyRule={handleUpdateLoyaltyRule}
                    onCreateLoyaltyRule={handleCreateLoyaltyRule}
                    onDeleteLoyaltyRule={handleDeleteLoyaltyRule}
                    onResetAllLoyaltyPoints={handleResetAllLoyaltyPoints}
                    loyaltyEnabled={loyaltyEnabled}
                    onToggleLoyalty={handleToggleLoyalty}
                    messagingEnabled={messagingEnabled}
                    onToggleMessaging={handleToggleMessaging}
                    onRemoveAllMessages={handleRemoveAllMessages}
                    clinicalFeeEnabled={clinicalFeeEnabled}
                    clinicalFeeNewPatientAmount={clinicalFeeNewPatientAmount}
                    clinicalFeeReturningPatientAmount={clinicalFeeReturningPatientAmount}
                    onSaveClinicalFeeSettings={handleSaveClinicalFeeSettings}
                    autoOnpPatientTypeEnabled={autoOnpPatientTypeEnabled}
                    onAutoOnpPatientTypeChange={handleAutoOnpPatientTypeChange}
                    patientTypes={patientTypes}
                    appointmentTypes={appointmentTypes}
                    onCreatePatientType={async (data) => {
                      await api.patientTypes.create(data);
                      setPatientTypes(await api.patientTypes.getAll());
                    }}
                    onUpdatePatientType={async (id, data) => {
                      await api.patientTypes.update(id, data);
                      setPatientTypes(await api.patientTypes.getAll());
                      await fetchInitialData(currentLocationId || undefined);
                    }}
                    onDeletePatientType={async (id) => {
                      await api.patientTypes.delete(id);
                      setPatientTypes(await api.patientTypes.getAll());
                    }}
                    onCreateAppointmentType={async (data) => {
                      await api.appointmentTypes.create(data);
                      setAppointmentTypes(await api.appointmentTypes.getAll());
                    }}
                    onUpdateAppointmentType={async (id, data) => {
                      await api.appointmentTypes.update(id, data);
                      setAppointmentTypes(await api.appointmentTypes.getAll());
                    }}
                    onDeleteAppointmentType={async (id) => {
                      await api.appointmentTypes.delete(id);
                      setAppointmentTypes(await api.appointmentTypes.getAll());
                    }}
                    isAdmin={isAdmin}
                    appName={appName}
                    appLogoUrl={appLogoUrl}
                    onSaveAppName={handleSaveAppName}
                    onUploadAppLogo={handleUploadAppLogo}
                    onDeleteAppLogo={handleDeleteAppLogo}
                    receiptInfo={receiptInfo}
                    onSaveReceiptInfo={handleSaveReceiptInfo}
                    receiptHeaderTitle={receiptHeaderTitle}
                    onSaveReceiptHeaderTitle={handleSaveReceiptHeaderTitle}
                    receiptSize={receiptSize}
                    onReceiptSizeChange={handleReceiptSizeChange}
                    hoverTheme={hoverTheme}
                    onHoverThemeChange={handleHoverThemeChange}
                />
              )
            )}
            {currentView === 'branch-switching' && !isAdmin && !isDoctor && canAccessView('branch-switching') && (
              <BranchSwitcherView
                locations={locations}
                currentLocationId={currentLocationId}
                onLocationChange={handleLocationChange}
              />
            )}
            {currentView === 'ai-assistant' && canAccessView('ai-assistant') && <AIAssistantView 
                patients={assistantPatients} 
                treatmentRecords={assistantRecords} 
                appointments={assistantAppointments}
                doctors={assistantDoctors}
                treatmentTypes={assistantTreatmentTypes}
                users={users}
                medicines={assistantMedicines}
                expenses={assistantExpenses}
                medicineSales={assistantMedicineSales}
                paymentRecords={assistantPaymentRecords}
                locations={locations}
                currentLocationId={currentLocationId}
                canAccessAllLocations={false}
                currentAdminId={auth.getCurrentUser()?.userId}
                currency={currency}
                onDataRefresh={refreshAssistantData}
              />}
            {currentView === 'messaging' && canAccessView('messaging') && <MessagingView 
              patients={patients} 
              messagingEnabled={messagingEnabled}
              locationId={currentLocationId || undefined}
            />}
            {currentView === 'finance' && <ClinicalView 
                selectedPatient={selectedPatient} 
                patients={patients}
                locations={locations}
                doctors={doctors}
                selectedDoctorId={selectedDoctorId}
                selectedTeeth={selectedTeeth} 
                treatmentTypes={treatmentTypes} 
                treatmentHistory={treatmentHistory}
                treatmentHistoryLoading={treatmentHistoryLoading}
                medicineSales={patientMedicineSales}
                medicineHistoryLoading={patientMedicineHistoryLoading}
                medicineHistoryError={patientMedicineHistoryError}
                paymentRecords={patientPaymentRecords}
                paymentHistoryLoading={patientPaymentHistoryLoading}
                paymentHistoryError={patientPaymentHistoryError}
                paymentsAvailable={auth.getSession()?.role !== 'doctor'}
                patientFiles={patientFiles}
                uploadingFiles={uploading}
                useFlatRate={useFlatRate}
                currency={currency}
                onUploadFiles={handleUploadFiles}
                onUploadFilesWithProgress={handleUploadFilesWithProgress}
                onDeleteFile={handleDeleteFile}
                onToggleTooth={(id) => setSelectedTeeth(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])}
                onSelectTeeth={setSelectedTeeth}
                onDoctorChange={setSelectedDoctorId}
                onDeselectAll={() => setSelectedTeeth([])}
                onTreatmentSubmit={handleTreatmentSubmit}
                onPaymentRequest={handleOpenPaymentModal}
                onOpenPaymentReceipt={auth.getSession()?.role !== 'doctor' ? handleOpenStoredPaymentReceipt : undefined}
                onServiceFeeRequest={handleOpenServiceFeePayment}
                onClosePatient={handleClosePatient}
                onSelectPatient={handlePatientSelect}
                onOpenDirectory={() => setCurrentView('patients')}
                onGenerateReceipt={handleGenerateReceipt}
                onAddMedicines={handleAddMedicines}
                onToggleFlatRate={setUseFlatRate}
                onUndoTreatment={handleUndoTreatment}
                onUndoMedicineSale={handleUndoMedicineSale}
                onRedeemPoints={handleRedeemPoints}
                onUpdatePatient={async (id, data) => {
                  try {
                    await api.patients.update(id, data);
                    fetchInitialData(currentLocationId || undefined);
                    // update selectedPatient to reflect changes
                    const updated = await api.patients.getAll(currentLocationId || undefined);
                    const p = updated.find(x => x.id === id);
                    setSelectedPatient(p || null);
                  } catch (err: any) {
                    alert('Error: ' + err.message);
                  }
                }}
                onUpdateAccount={async (patient, password) => {
                  try {
                    await api.patients.updateAccount(patient.id, patient.email || null, password, patient.phone || null);
                    alert('Patient account updated successfully!');
                    fetchInitialData();
                  } catch (err: any) {
                    alert('Error: ' + err.message);
                    throw err;
                  }
                }}
                onCreateAppointment={handleCreateAppointmentFromClinical}
                appointmentTypes={appointmentTypes}
                appointments={appointments}
                loyaltyEnabled={loyaltyEnabled}
                compactToothSelector={true}
                doctorMobileView={isDoctor}
                loyaltyRules={loyaltyRules}
                loyaltyTransactions={loyaltyTransactions}
            />}
          </Suspense>
        </div>
      </main>

      {isDoctor && (
        <nav
          className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white px-2 pt-2 pb-5"
        >
          {isTabPending && <div className="h-0.5 w-full bg-indigo-100"><div className="h-full w-1/3 bg-indigo-500 animate-pulse" /></div>}
          <div className="mx-auto flex max-w-md justify-around">
            {doctorMobileTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleDoctorTabChange(tab.key)}
                className={`flex max-w-[80px] flex-1 flex-col items-center rounded-xl px-2 py-2 text-[10px] transition-colors ${
                  tab.isActive ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:text-gray-700'
                }`}
                aria-label={tab.label}
              >
                <span className="mb-1 flex h-6 w-6 items-center justify-center">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* Modals */}
      {showPatientModal && (
        <Modal title={convertingLeadAppointment ? "Register New Patient" : "Register Clinical Patient"} onClose={() => { setShowPatientModal(false); setConvertingLeadAppointment(null); setPatientDuplicateWarning(null); setShowPatientCreationDate(false); setPatientCreationDate(toLocalDateInputValue()); }}>
          <form onSubmit={handleCreatePatient} className="space-y-6">
            {convertingLeadAppointment && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Linked Appointment</p>
                <p className="mt-1 text-sm font-bold text-amber-900">
                  {convertingLeadAppointment.date} at {convertingLeadAppointment.time}
                </p>
                <p className="mt-1 text-xs text-amber-700">
                  This patient profile will be linked back to the existing new patient appointment.
                </p>
              </div>
            )}

            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/30 p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-indigo-900">Account creation date</h3>
                  <p className="mt-1 text-xs text-indigo-600">
                    Defaults to today. Use a past date when entering an existing patient record.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowPatientCreationDate(current => !current);
                    setPatientCreationDate(current => current || toLocalDateInputValue());
                  }}
                  className="flex-none rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-bold text-indigo-700 transition-colors hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  aria-expanded={showPatientCreationDate}
                  aria-controls="patient-creation-date-field"
                >
                  {showPatientCreationDate ? 'Use today' : 'Advanced'}
                </button>
              </div>
              {showPatientCreationDate && (
                <div id="patient-creation-date-field" className="mt-4">
                  <label htmlFor="patient-creation-date" className="block text-[10px] font-black uppercase tracking-wider text-indigo-700">
                    Creation date
                  </label>
                  <input
                    id="patient-creation-date"
                    type="date"
                    required
                    min="1900-01-01"
                    max={toLocalDateInputValue()}
                    value={patientCreationDate}
                    onChange={(event) => setPatientCreationDate(event.target.value)}
                    className="mt-1.5 w-full rounded-2xl border border-indigo-200 bg-white p-3 text-sm text-gray-900 transition-all focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/30"
                  />
                  <p className="mt-2 text-[11px] text-indigo-500">Future dates are not allowed.</p>
                </div>
              )}
            </div>

            {/* ═══ PERSONAL INFORMATION ═══ */}
            <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
                Personal Information
              </h3>
              <Input label="Full Patient Name" required value={newPatientData.name} onChange={(e: any) => { setNewPatientData({...newPatientData, name: e.target.value}); setPatientDuplicateWarning(null); }} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Age</label>
                  <input
                    type="number"
                    min="0"
                    max="150"
                    required
                    className="w-full border-gray-200 border rounded-2xl p-3 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all"
                    value={newPatientData.age ?? ''}
                    onChange={(e) => { setNewPatientData({...newPatientData, age: e.target.value ? parseInt(e.target.value, 10) : undefined}); setPatientDuplicateWarning(null); }}
                    onBlur={() => { void validateNewPatientDuplicate(); }}
                    placeholder="Enter age"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Patient Type</label>
                  <select
                    className="w-full border-gray-200 border rounded-2xl p-3 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all bg-white"
                    value={newPatientData.patient_type || activePatientTypeOptions[0] || DEFAULT_PATIENT_TYPE_NAME}
                    onChange={(e) => setNewPatientData({...newPatientData, patient_type: e.target.value})}
                  >
                    {patientTypeOptionsForNewPatient.map((patientType) => (
                      <option key={patientType} value={patientType}>{patientType}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* ═══ CONTACT DETAILS ═══ */}
            <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
                Contact Details
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input label="Primary Email" type="email" value={newPatientData.email} onChange={(e: any) => setNewPatientData({...newPatientData, email: e.target.value})} />
                <Input label="Mobile Contact" required value={newPatientData.phone} onChange={(e: any) => { setNewPatientData({...newPatientData, phone: e.target.value}); setPatientDuplicateWarning(null); }} onBlur={() => { void validateNewPatientDuplicate(); }} />
              </div>
            </div>

            {isNewPatientAgeMissing && (
              <div role="alert" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>Please add the patient's age before finalizing registration.</span>
              </div>
            )}
            {patientDuplicateWarning && (
              <div role="alert" className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{patientDuplicateWarning}</span>
              </div>
            )}

            {/* ═══ LOCATION ═══ */}
            <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
                Location
              </h3>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Branch / Location</label>
                <select
                  className="w-full border-gray-200 border rounded-2xl p-3 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all bg-white"
                  value={newPatientData.location_id || ''}
                  onChange={(e) => setNewPatientData({...newPatientData, location_id: e.target.value})}
                >
                  <option value="">Select a branch...</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">City</label>
                  <SearchableSelect
                    value={newPatientData.city || ''}
                    onChange={(selectedCity) => {
                      const allowedTownships = getTownshipsForCity(selectedCity);
                      const nextTownship = allowedTownships.includes(newPatientData.township || '') ? newPatientData.township : '';
                      setNewPatientData({ ...newPatientData, city: selectedCity, township: nextTownship });
                    }}
                    options={cityOptions}
                    placeholder="Select City"
                    emptyMessage="No city found"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Township</label>
                  <SearchableSelect
                    value={newPatientData.township || ''}
                    onChange={(selectedTownship) => setNewPatientData({ ...newPatientData, township: selectedTownship })}
                    options={townshipOptionsForNewPatient}
                    placeholder={newPatientData.city ? 'Select Township' : 'Select City first'}
                    emptyMessage={newPatientData.city ? 'No township found for this city' : 'Choose city first'}
                  />
                </div>
              </div>
            </div>

            {/* ═══ CLINICAL FEE INFO ═══ */}
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5">
              <p className="text-[10px] font-black uppercase tracking-wide text-indigo-700 mb-2">Patient Service Fee</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-700">
                  The fee is shown during payment collection based on whether this patient is new or returning.
                </p>
                <span className="text-xs font-semibold text-indigo-700">
                  New patient: {formatCurrency(clinicalFeeNewPatientAmount, currency)}
                </span>
              </div>
              <p className={`mt-2 text-xs ${clinicalFeeEnabled ? 'text-indigo-700' : 'text-amber-700'}`}>
                {clinicalFeeEnabled
                  ? 'During payment collection, staff can continue with the suggested service fee or continue without it.'
                  : 'Patient service fees are currently disabled in Settings.'}
              </p>
            </div>

            {/* ═══ ADDRESS ═══ */}
            <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
                Address
              </h3>
              <Input label="Street Address" placeholder="Street address" value={newPatientData.address || ''} onChange={(e: any) => setNewPatientData({...newPatientData, address: e.target.value})} />
            </div>

            {/* ═══ PATIENT PORTAL ACCOUNT ═══ */}
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/30 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-indigo-700">
                <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
                Patient Portal Account (Optional)
              </h3>
              <Input 
                label="Set Password" 
                type="password" 
                placeholder="Leave blank to create without account"
                value={newPatientData.password} 
                onChange={(e: any) => setNewPatientData({...newPatientData, password: e.target.value})} 
              />
              <p className="text-[11px] text-indigo-400">If set, patient can log in using their Name/Phone and this password.</p>
            </div>

            {/* ═══ MEDICAL HISTORY ═══ */}
            <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
                Medical History
              </h3>
              <textarea className="w-full border-gray-200 border rounded-2xl p-4 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all min-h-[100px]" rows={4}
                value={newPatientData.medicalHistory} onChange={e => setNewPatientData({...newPatientData, medicalHistory: e.target.value})} />
            </div>
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3.5 rounded-2xl font-semibold text-sm shadow-lg shadow-indigo-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isSubmitting ? 'Registering...' : 'Register Patient'}
            </button>
          </form>
        </Modal>
      )}

      {showAppointmentModal && (
        <Modal
          title={editingAppointment ? "Edit Appointment" : "New Appointment"}
          onClose={() => {setShowAppointmentModal(false); setEditingAppointment(null); resetAppointmentForm();}}
          maxWidthClassName="max-w-xl"
        >
          <form onSubmit={handleCreateAppointment} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Appointment For</label>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setAppointmentPatientMode('registered');
                    setAppointmentDuplicateWarning(null);
                    setNewAppointmentData({
                      ...newAppointmentData,
                      guest_name: '',
                      guest_phone: '',
                      guest_email: '',
                      guest_age: '',
                      guest_address: '',
                      guest_password: '',
                      guest_source: '',
                      guest_notes: ''
                    });
                  }}
                  className={`rounded-lg px-3 py-2 text-xs font-bold transition-colors ${appointmentPatientMode === 'registered' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                >
                  Registered Patient
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAppointmentPatientMode('lead');
                    setAppointmentDuplicateWarning(null);
                    setNewAppointmentData({ ...newAppointmentData, patient_id: '' });
                  }}
                  className={`rounded-lg px-3 py-2 text-xs font-bold transition-colors ${appointmentPatientMode === 'lead' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                >
                  New Patient
                </button>
              </div>
            </div>

            {appointmentPatientMode === 'registered' ? (
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Patient</label>
                <SearchableSelect
                  value={newAppointmentData.patient_id || ''}
                  onChange={handleAppointmentPatientChange}
                  options={appointmentPatientOptions}
                  placeholder="Search patient by name or phone"
                  emptyMessage="No patients found for this branch"
                />
              </div>
            ) : (
              <div className="space-y-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label="New Patient Name"
                    required
                    value={newAppointmentData.guest_name || ''}
                    onChange={(e: any) => { setNewAppointmentData({...newAppointmentData, guest_name: e.target.value}); setAppointmentDuplicateWarning(null); }}
                    placeholder="Name for follow-up"
                  />
                  <Input
                    label="New Patient Phone"
                    required
                    value={newAppointmentData.guest_phone || ''}
                    onChange={(e: any) => { setNewAppointmentData({...newAppointmentData, guest_phone: e.target.value}); setAppointmentDuplicateWarning(null); }}
                    onBlur={() => { void validateAppointmentLeadDuplicate(); }}
                    placeholder="09..."
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label="New Patient Age"
                    type="number"
                    min="0"
                    value={newAppointmentData.guest_age || ''}
                    onChange={(e: any) => { setNewAppointmentData({...newAppointmentData, guest_age: e.target.value}); setAppointmentDuplicateWarning(null); }}
                    onBlur={() => { void validateAppointmentLeadDuplicate(); }}
                    placeholder="25"
                  />
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">New Patient Source</label>
                    <select
                      className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 bg-white"
                      value={newAppointmentData.guest_source || ''}
                      onChange={(e: any) => setNewAppointmentData({...newAppointmentData, guest_source: e.target.value})}
                    >
                      <option value="">Select source</option>
                      {leadSourceOptionsForAppointment.map(source => (
                        <option key={source} value={source}>{source}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label="New Patient Email"
                    type="email"
                    value={newAppointmentData.guest_email || ''}
                    onChange={(e: any) => setNewAppointmentData({...newAppointmentData, guest_email: e.target.value})}
                    placeholder="Optional email for portal login"
                  />
                  <Input
                    label="Portal Password"
                    type="password"
                    minLength={4}
                    value={newAppointmentData.guest_password || ''}
                    onChange={(e: any) => setNewAppointmentData({...newAppointmentData, guest_password: e.target.value})}
                    placeholder="Optional password for patient portal"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">New Patient Address</label>
                  <textarea
                    className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                    rows={2}
                    value={newAppointmentData.guest_address || ''}
                    onChange={(e: any) => setNewAppointmentData({...newAppointmentData, guest_address: e.target.value})}
                    placeholder="Patient address for registration"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">New Patient Follow-up Notes</label>
                  <textarea
                    className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                    rows={2}
                    value={newAppointmentData.guest_notes || ''}
                    onChange={(e: any) => setNewAppointmentData({...newAppointmentData, guest_notes: e.target.value})}
                    placeholder="Marketing context, caller request, preferred contact time..."
                  />
                </div>
                {appointmentDuplicateWarning && (
                  <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <span>{appointmentDuplicateWarning}</span>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Doctor (Optional)</label>
                <div className="relative" ref={doctorDropdownRef}>
                  <div className="relative">
                    <input
                      type="text"
                      disabled={Boolean(editingAppointment) && !isAdmin}
                      className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 pr-10 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
                      placeholder="Search doctor..."
                      value={doctorSearchQuery}
                      onChange={(e) => {
                        setDoctorSearchQuery(e.target.value);
                        setShowDoctorDropdown(true);
                      }}
                      onFocus={() => {
                        if (!editingAppointment || isAdmin) setShowDoctorDropdown(true);
                      }}
                      onBlur={() => {
                        setTimeout(() => setShowDoctorDropdown(false), 200);
                      }}
                    />
                    {newAppointmentData.doctor_id && (!editingAppointment || isAdmin) && (
                      <button
                        type="button"
                        onClick={() => {
                          handleDoctorChange('');
                          setDoctorSearchQuery('');
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {showDoctorDropdown && (!editingAppointment || isAdmin) && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl max-h-60 overflow-y-auto">
                      <button
                        type="button"
                        className="w-full px-4 py-2.5 text-sm text-left hover:bg-gray-50 border-b border-gray-100"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleDoctorChange('');
                          setShowDoctorDropdown(false);
                        }}
                      >
                        <span className="text-gray-500">No specific doctor</span>
                      </button>
                      {filteredDoctors.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-gray-500 text-center">No doctors found</div>
                      ) : (
                        filteredDoctors.map(doctor => (
                          <button
                            type="button"
                            key={doctor.id}
                            className={`w-full px-4 py-2.5 text-sm text-left hover:bg-indigo-50 ${
                              newAppointmentData.doctor_id === doctor.id ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'
                            }`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleDoctorChange(doctor.id);
                              setShowDoctorDropdown(false);
                            }}
                          >
                            <div className="font-medium">{doctor.name}</div>
                            {doctor.specialization && (
                              <div className="text-xs text-gray-500">{doctor.specialization}</div>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {editingAppointment && !isAdmin && (
                  <p className="mt-1.5 text-xs font-medium text-amber-700">
                    Only an administrator can change the assigned doctor.
                  </p>
                )}
                {editingAppointment && isAdmin && (
                  <p className="mt-1.5 text-xs font-medium text-indigo-600">
                    Doctor changes are saved through the secure correction workflow. Visits with treatment records require Correct Doctor review.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Type</label>
                <SearchableSelect
                  value={newAppointmentData.type || ''}
                  onChange={(selectedType) => {
                    setNewAppointmentData({ ...newAppointmentData, type: selectedType });
                    if (!appointmentClinicalFocus.trim()) {
                      setAppointmentClinicalFocus(selectedType);
                    }
                  }}
                  options={appointmentTypeOptionsForModal.map((typeName) => ({ value: typeName, label: typeName }))}
                  placeholder="Select appointment type"
                  emptyMessage="No appointment type found"
                />
                {appointmentTypeOptions.length === 0 && (
                  <p className="text-xs text-amber-600 mt-1">No appointment types configured yet. Add appointment types in Settings first.</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Input 
                  label="Date" 
                  type="date" 
                  required 
                  value={newAppointmentData.date} 
                  onChange={(e: any) => handleDateChange(e.target.value)} 
                />
              </div>
              <div>
                <TimeInput
                  label="Time"
                  required 
                  value={newAppointmentData.time} 
                  onChange={(time) => setNewAppointmentData({...newAppointmentData, time})}
                />
              </div>
            </div>
            {editingAppointment && editingAppointment.date !== newAppointmentData.date && (
              <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Reschedule Reason</p>
                  <p className="mt-1 text-xs text-amber-700">
                    This date change will be recorded in the Audit Log as a rescheduled appointment.
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Reason</label>
                  <select
                    className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 bg-white"
                    value={appointmentRescheduleReasonPreset}
                    onChange={(e: any) => setAppointmentRescheduleReasonPreset(e.target.value)}
                  >
                    <option value="Patient did not arrive">Patient did not arrive</option>
                    <option value="Patient requested a different date">Patient requested a different date</option>
                    <option value="Doctor unavailable">Doctor unavailable</option>
                    <option value="Clinic scheduling conflict">Clinic scheduling conflict</option>
                    <option value="Treatment not ready">Treatment not ready</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                {appointmentRescheduleReasonPreset === 'Other' && (
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Custom Reason</label>
                    <textarea
                      className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                      rows={2}
                      value={appointmentRescheduleReasonCustom}
                      onChange={(e: any) => setAppointmentRescheduleReasonCustom(e.target.value)}
                      placeholder="Type the reschedule reason"
                    />
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Branch / Location</label>
                <select
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                  value={newAppointmentData.location_id || ''}
                  onChange={(e: any) => setNewAppointmentData({ ...newAppointmentData, location_id: e.target.value })}
                >
                  <option value="">Select a branch...</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Status</label>
                <select 
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500"
                  value={newAppointmentData.status} 
                  onChange={(e: any) => setNewAppointmentData({...newAppointmentData, status: e.target.value})}
                >
                  <option value="Scheduled">Scheduled</option>
                  <option value="Completed">Completed</option>
                  <option value="Cancelled">Cancelled</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Clinical Focus</label>
              <input
                className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                value={appointmentClinicalFocus}
                onChange={(e) => setAppointmentClinicalFocus(e.target.value)}
                placeholder="e.g., Filling, extraction, consultation"
              />
            </div>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Extra Notes</label>
                <textarea
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  rows={3}
                  value={appointmentGeneralNotes}
                  onChange={(e: any) => setAppointmentGeneralNotes(e.target.value)}
                  placeholder="Optional additional instructions..."
                />
              </div>
            </div>
            <button type="submit" className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20">
              {editingAppointment ? 'Update Appointment' : 'Create Appointment'}
            </button>
          </form>
        </Modal>
      )}

      {showDoctorModal && (
        <Modal
          title={editingDoctor ? "Edit Doctor" : "New Doctor"}
          onClose={() => {setShowDoctorModal(false); setEditingDoctor(null); resetDoctorCommissionEditor();}}
          maxWidthClassName="max-w-3xl"
        >
          <form onSubmit={handleCreateDoctor} className="space-y-5">
            <Input label="Doctor Name" required value={newDoctorData.name} onChange={(e: any) => setNewDoctorData({...newDoctorData, name: e.target.value})} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input label="Email" type="email" value={newDoctorData.email} onChange={(e: any) => setNewDoctorData({...newDoctorData, email: e.target.value})} />
              <Input label="Phone" value={newDoctorData.phone} onChange={(e: any) => setNewDoctorData({...newDoctorData, phone: e.target.value})} />
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Branches / Locations</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {locations.map((loc) => (
                  <label key={loc.id} className="flex items-center gap-2 rounded-xl border border-gray-200 p-3 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      checked={(newDoctorData.location_ids || [newDoctorData.location_id].filter(Boolean)).includes(loc.id)}
                      onChange={(e: any) => {
                        const selected = new Set(newDoctorData.location_ids || [newDoctorData.location_id].filter(Boolean));
                        e.target.checked ? selected.add(loc.id) : selected.delete(loc.id);
                        const location_ids = Array.from(selected);
                        setNewDoctorData({ ...newDoctorData, location_ids, location_id: location_ids[0] || '' });
                      }}
                    />
                    {loc.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="doctor-specialization" className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Specialization</label>
                <input
                  id="doctor-specialization"
                  type="text"
                  maxLength={255}
                  list="doctor-specialization-options"
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                  value={newDoctorData.specialization || 'General'}
                  onChange={(e: any) => setNewDoctorData({ ...newDoctorData, specialization: e.target.value })}
                  placeholder="e.g., Pediatric Dentistry"
                />
                <datalist id="doctor-specialization-options">
                  {DOCTOR_SPECIALIZATIONS.map((specialization) => (
                    <option key={specialization} value={specialization}>{specialization}</option>
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-gray-400">Choose a suggestion or enter your clinic's own specialty.</p>
              </div>
              <div>
                <label htmlFor="doctor-commission-type" className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Commission Method</label>
                <select
                  id="doctor-commission-type"
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                  value={resolveDoctorCommissionType({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization })}
                  onChange={(e: any) => setNewDoctorData({ ...newDoctorData, commission_type: e.target.value })}
                >
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed">Fixed amount per visit ({getCurrencySymbol(currency)})</option>
                </select>
                <p className="mt-1 text-xs text-gray-400">This choice is independent of specialization.</p>
              </div>
              <div>
                <label htmlFor="doctor-commission-value" className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">
                  {usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? `Commission Per Visit (${getCurrencySymbol(currency)})` : 'Commission Percentage (%)'}
                </label>
                <div className="relative">
                  <input
                    id="doctor-commission-value"
                    type="number"
                    min="0"
                    step="0.01"
                    className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent pr-8"
                    {...(usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? {} : { max: 100 })}
                    value={usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? (newDoctorData.commission_per_visit ?? 0) : (newDoctorData.commission_percentage ?? 0)}
                    onChange={(e: any) => setNewDoctorData(usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? { ...newDoctorData, commission_per_visit: parseFloat(e.target.value) || 0 } : { ...newDoctorData, commission_percentage: parseFloat(e.target.value) || 0 })}
                    placeholder={usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? 'e.g., 50000' : 'e.g., 50'}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-medium">{usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? getCurrencySymbol(currency) : '%'}</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">{usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? 'Fixed amount paid once per patient visit.' : 'Percentage of collected treatment fees after treatment costs.'}</p>
                <button
                  type="button"
                  onClick={() => {
                    setDoctorCommissionAdvancedOpen((prev) => {
                      const next = !prev;
                      if (next && doctorCommissionRows.length === 0) {
                        setDoctorCommissionRows([createEmptyDoctorCommissionRow()]);
                      }
                      return next;
                    });
                  }}
                  className="mt-2 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                >
                  {doctorCommissionAdvancedOpen ? 'Hide advanced treatment commission setup' : 'Advanced: Set custom commission per treatment'}
                </button>
              </div>
            </div>
            {doctorCommissionAdvancedOpen && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Custom Treatment Commissions</label>
                    <p className="text-xs text-gray-500">
                      {usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization })
                        ? 'Override the default fixed per-visit amount for specific treatments. If no custom amount exists, the amount above is used.'
                        : 'Override the default commission percentage for specific treatments. If no custom rate exists, the percentage above is used.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDoctorCommissionRows((prev) => [...prev, createEmptyDoctorCommissionRow()])}
                    className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-indigo-50"
                  >
                    + Add Treatment Commission
                  </button>
                </div>
                <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
                  {doctorCommissionLoading ? (
                    <div className="rounded-lg bg-white px-4 py-6 text-center text-sm text-gray-500">
                      Loading custom commission rates...
                    </div>
                  ) : doctorCommissionRows.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-sm text-gray-500">
                              No custom treatment commissions yet.
                    </div>
                  ) : (
                    doctorCommissionRows.map((row, index) => (
                      <div key={row.id || `doctor-commission-${index}`} className="grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-white p-3 sm:grid-cols-[1fr_160px_auto] sm:items-end">
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Treatment</label>
                          <select
                            className="w-full border-gray-200 border rounded-lg p-2 text-sm bg-white"
                            value={row.treatment_id}
                            onChange={(e: any) => {
                              const updated = [...doctorCommissionRows];
                              updated[index] = { ...updated[index], treatment_id: e.target.value };
                              setDoctorCommissionRows(updated);
                            }}
                          >
                            <option value="">Select treatment</option>
                            {treatmentTypes.map((treatment) => (
                              <option key={treatment.id} value={treatment.id}>{treatment.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">
                            {usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization })
                              ? `Fixed Amount (${getCurrencySymbol(currency)})`
                              : 'Commission %'}
                          </label>
                          <input
                            type="number"
                            min="0"
                            {...(usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? {} : { max: 100 })}
                            step="0.01"
                            className="w-full border-gray-200 border rounded-lg p-2 text-sm"
                            value={usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization }) ? (row.fixed_amount ?? 0) : row.commission_rate}
                            onChange={(e: any) => {
                              const updated = [...doctorCommissionRows];
                              const value = parseFloat(e.target.value) || 0;
                              updated[index] = usesFlatVisitCommission({ commissionType: newDoctorData.commission_type, specialization: newDoctorData.specialization })
                                ? { ...updated[index], fixed_amount: value }
                                : { ...updated[index], commission_rate: value };
                              setDoctorCommissionRows(updated);
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const updated = [...doctorCommissionRows];
                            updated.splice(index, 1);
                            setDoctorCommissionRows(updated);
                          }}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            <div>
              <Input
                label={editingDoctor ? 'Doctor Login Password (optional)' : 'Doctor Login Password'}
                type="password"
                required={!editingDoctor}
                value={newDoctorData.password || ''}
                onChange={(e: any) => setNewDoctorData({ ...newDoctorData, password: e.target.value })}
                placeholder={editingDoctor ? 'Leave blank to keep current password' : 'Set initial login password'}
              />
              <p className="mt-2 text-xs text-gray-500">
                Doctor will sign in from Staff Login using their email as username.
              </p>
            </div>
            
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Working Schedule</label>
              <div className="space-y-3 border border-gray-200 rounded-xl p-4 bg-gray-50">
                {(newDoctorData.schedules || []).map((schedule, index) => (
                  <div key={index} className="grid grid-cols-1 gap-3 bg-white p-3 rounded-lg border border-gray-200 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                    <div className="flex-1">
                      <label className="block text-xs text-gray-600 mb-1">Day</label>
                      <select
                        className="w-full border-gray-200 border rounded-lg p-2 text-sm"
                        value={schedule.day_of_week}
                        onChange={(e: any) => {
                          const updated = [...(newDoctorData.schedules || [])];
                          updated[index].day_of_week = parseInt(e.target.value);
                          setNewDoctorData({...newDoctorData, schedules: updated});
                        }}
                      >
                        <option value={0}>Sunday</option>
                        <option value={1}>Monday</option>
                        <option value={2}>Tuesday</option>
                        <option value={3}>Wednesday</option>
                        <option value={4}>Thursday</option>
                        <option value={5}>Friday</option>
                        <option value={6}>Saturday</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs text-gray-600 mb-1">Start Time</label>
                      <input
                        type="time"
                        className="w-full border-gray-200 border rounded-lg p-2 text-sm"
                        value={schedule.start_time}
                        onChange={(e: any) => {
                          const updated = [...(newDoctorData.schedules || [])];
                          updated[index].start_time = e.target.value;
                          setNewDoctorData({...newDoctorData, schedules: updated});
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs text-gray-600 mb-1">End Time</label>
                      <input
                        type="time"
                        className="w-full border-gray-200 border rounded-lg p-2 text-sm"
                        value={schedule.end_time}
                        onChange={(e: any) => {
                          const updated = [...(newDoctorData.schedules || [])];
                          updated[index].end_time = e.target.value;
                          setNewDoctorData({...newDoctorData, schedules: updated});
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const updated = [...(newDoctorData.schedules || [])];
                        updated.splice(index, 1);
                        setNewDoctorData({...newDoctorData, schedules: updated});
                      }}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setNewDoctorData({
                      ...newDoctorData,
                      schedules: [...(newDoctorData.schedules || []), { id: '', day_of_week: 1, start_time: '09:00', end_time: '17:00' }]
                    });
                  }}
                  className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
                >
                  + Add Schedule
                </button>
              </div>
            </div>
            {doctorCommissionLoadError && (
              <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Custom commission rates could not be loaded. Close and reopen this form before saving.
              </p>
            )}
            <button
              type="submit"
              disabled={isSubmitting || doctorCommissionLoading || Boolean(doctorCommissionLoadError)}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (editingDoctor ? 'Updating...' : 'Creating...') : (editingDoctor ? 'Update Doctor' : 'Create Doctor')}
            </button>
          </form>
        </Modal>
      )}

      {doctorTransferBlockedOpen && (
        <Modal
          title="Doctor Transfer Blocked"
          onClose={() => {
            setDoctorTransferBlockedOpen(false);
            setDoctorTransferBlockedReasons([]);
          }}
          maxWidthClassName="max-w-md"
        >
          <div className="space-y-5">
            <div className="rounded-3xl border border-amber-100 bg-gradient-to-br from-amber-50 via-white to-orange-50 p-4 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
                  <AlertTriangle size={22} />
                </div>
                <div>
                  <p className="text-base font-black tracking-tight text-gray-900">
                    This doctor cannot be transferred to another branch.
                  </p>
                  <p className="mt-2 text-sm leading-6 text-gray-600">
                    Existing branch-linked activity was found for this doctor.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                Why This Is Blocked
              </p>
              <p className="mt-2 text-sm leading-6 text-gray-700">
                This doctor has existing records in the current branch:
              </p>
              <ul className="mt-3 space-y-2">
                {doctorTransferBlockedReasons.map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm font-medium text-gray-700">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm leading-6 text-gray-700">
                Resolve or move these records first before transferring the doctor to another branch.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setDoctorTransferBlockedOpen(false);
                setDoctorTransferBlockedReasons([]);
              }}
              className="w-full rounded-2xl bg-amber-600 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-amber-600/20 transition-all hover:bg-amber-700 hover:shadow-amber-700/25"
            >
              Understood
            </button>
          </div>
        </Modal>
      )}

      {showTreatmentTypeModal && (
        <Modal title={editingTreatmentType ? "Update Service Definition" : "New Service Definition"} onClose={() => setShowTreatmentTypeModal(false)}>
          <form onSubmit={handleCreateTreatmentType} className="space-y-5">
            <Input label="Service Description" required value={newTreatmentTypeData.name} onChange={(e: any) => setNewTreatmentTypeData({...newTreatmentTypeData, name: e.target.value})} />
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Specialty Department</label>
              <input
                list="treatment-category-suggestions"
                className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                required
                value={newTreatmentTypeData.category || ''}
                onChange={(e) => setNewTreatmentTypeData({ ...newTreatmentTypeData, category: e.target.value })}
                placeholder="Type or pick a specialty category"
              />
              <datalist id="treatment-category-suggestions">
                {treatmentCategorySuggestions.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </div>
            <Input label={`Standard Fee (${getCurrencySymbol(currency)})`} type="number" required min="0" value={newTreatmentTypeData.cost} onChange={(e: any) => setNewTreatmentTypeData({...newTreatmentTypeData, cost: parseFloat(e.target.value)})} />
            <button type="submit" className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg">Save Configuration</button>
          </form>
        </Modal>
      )}

      {showUserModal && isAdmin && (
        <Modal title={editingUser ? "Edit User" : "New User"} onClose={() => {setShowUserModal(false); setEditingUser(null); setUserFormError(null); setNewUserData(getDefaultUserFormData());}}>
          <form onSubmit={handleCreateUser} className="space-y-5">
            <Input 
              label="Username" 
              required 
              value={newUserData.username} 
              onChange={(e: any) => {setUserFormError(null); setNewUserData({...newUserData, username: e.target.value});}} 
              placeholder="Enter username"
            />
            <Input 
              label={editingUser ? "New Password (leave blank to keep current)" : "Password"} 
              type="password"
              required={!editingUser}
              value={newUserData.password || ''} 
              onChange={(e: any) => {setUserFormError(null); setNewUserData({...newUserData, password: e.target.value});}} 
              placeholder="Enter password"
            />
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Assign Location</label>
              <select 
                className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500"
                value={newUserData.location_id || ''} 
                onChange={(e: any) => {
                  setUserFormError(null);
                  const locationId = e.target.value || null;
                  setNewUserData({
                    ...newUserData,
                    location_id: locationId,
                    allowed_tabs: locationId
                      ? resolveAllowedTabs('normal', newUserData.allowed_tabs).filter((tab) => tab !== 'branch-switching')
                      : newUserData.allowed_tabs
                  });
                }}
              >
                <option value="">{newUserData.role === 'admin' ? 'All Locations (Global Manager)' : 'All Assigned Locations'}</option>
                {locations.map(loc => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Role</label>
              <select 
                className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500"
                value={newUserData.role} 
                onChange={(e: any) => handleUserRoleChange(e.target.value)}
              >
                <option value="normal">Normal Staff</option>
                <option value="admin">Manager</option>
              </select>
            </div>
            {newUserData.role === 'admin' ? (
              <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3">
                <p className="text-sm font-semibold text-indigo-900">Manager accounts always get full system access.</p>
                <p className="mt-1 text-xs text-indigo-700">Users and Settings remain manager-only. Staff permissions below are only for normal accounts.</p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Tab Access</label>
                    <p className="text-sm text-gray-500">Choose which tabs this normal account can open.</p>
                  </div>
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-600">
                    {editableAllowedTabs.length} tab{editableAllowedTabs.length === 1 ? '' : 's'} selected
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {FLEXIBLE_STAFF_TABS.map(tab => {
                    const requiresAllLocations = tab.key === 'branch-switching';
                    const disabled = requiresAllLocations && !!newUserData.location_id;
                    const checked = editableAllowedTabs.includes(tab.key) && !disabled;
                    return (
                      <label
                        key={tab.key}
                        className={`flex gap-3 rounded-2xl border p-4 transition ${disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'} ${
                          checked ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleUserTabAccess(tab.key)}
                          disabled={disabled}
                          className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{tab.label}</p>
                          <p className="mt-1 text-xs text-gray-500">{tab.description}</p>
                          {requiresAllLocations && (
                            <p className="mt-2 text-[11px] font-semibold text-indigo-700">Requires All Assigned Locations.</p>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                {editableAllowedTabs.length === 0 && (
                  <p className="mt-3 text-xs font-medium text-red-600">Select at least one tab for this account.</p>
                )}
              </div>
            )}
            {userFormError && (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-sm font-semibold text-red-900">Couldn&apos;t save this user yet</p>
                <p className="mt-1 text-xs text-red-700">{userFormError}</p>
              </div>
            )}
            <button type="submit" className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20">
              {editingUser ? 'Update User' : 'Create User'}
            </button>
          </form>
        </Modal>
      )}

      {showMedicineModal && (
        <Modal title={editingMedicine ? "Edit Inventory Item" : "New Inventory Item"} onClose={() => {setShowMedicineModal(false); setEditingMedicine(null); setNewMedicineData({ name: '', description: '', unit: 'pack', item_type: 'Medicine', price: 0, stock: 0, min_stock: 0, quantity_step: 1, category: '' });}}>
          <form onSubmit={handleCreateMedicine} className="space-y-5">
            <Input 
              label="Item Name" 
              required 
              value={newMedicineData.name} 
              onChange={(e: any) => setNewMedicineData({...newMedicineData, name: e.target.value})} 
              placeholder="e.g., Amoxicillin, Toothbrush, Mouthwash"
            />
            <Input 
              label="Description" 
              value={newMedicineData.description || ''} 
              onChange={(e: any) => setNewMedicineData({...newMedicineData, description: e.target.value})} 
              placeholder="Optional description"
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Item Type</label>
                <select 
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500"
                  value={newMedicineData.item_type || 'Medicine'} 
                  onChange={(e: any) => setNewMedicineData({...newMedicineData, item_type: e.target.value as Medicine['item_type']})}
                >
                  <option value="Medicine">Medicine</option>
                  <option value="Retail">Retail Item</option>
                  <option value="Supply">Supply</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Unit</label>
                <select 
                  className="w-full border-gray-200 border rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500"
                  value={newMedicineData.unit} 
                  onChange={(e: any) => setNewMedicineData({...newMedicineData, unit: e.target.value})}
                >
                  <option value="pack">Pack</option>
                  <option value="bottle">Bottle</option>
                  <option value="box">Box</option>
                  <option value="card">Card</option>
                  <option value="strip">Strip</option>
                  <option value="tube">Tube</option>
                  <option value="piece">Piece</option>
                  <option value="unit">Unit</option>
                  <option value="tablet">Tablet</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input 
                label="Category" 
                value={newMedicineData.category || ''} 
                onChange={(e: any) => setNewMedicineData({...newMedicineData, category: e.target.value})} 
                placeholder="e.g., Antibiotics, Oral Care"
              />
              <Input
                label="Dispense Step"
                type="number"
                min="0.01"
                step="0.01"
                value={newMedicineData.quantity_step || 1}
                onChange={(e: any) => setNewMedicineData({...newMedicineData, quantity_step: Math.max(0.01, parseFloat(e.target.value) || 1)})}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Input 
                label={`Price (${getCurrencySymbol(currency)})`} 
                type="number" 
                required 
                min="0" 
                step="0.01"
                value={newMedicineData.price || 0} 
                onChange={(e: any) => setNewMedicineData({...newMedicineData, price: parseFloat(e.target.value) || 0})} 
              />
              <Input 
                label="Stock" 
                type="number" 
                required 
                min="0"
                step="0.01"
                value={newMedicineData.stock || 0} 
                onChange={(e: any) => setNewMedicineData({...newMedicineData, stock: parseFloat(e.target.value) || 0})} 
              />
              <Input 
                label="Min Stock" 
                type="number" 
                min="0"
                step="0.01"
                value={newMedicineData.min_stock || 0} 
                onChange={(e: any) => setNewMedicineData({...newMedicineData, min_stock: parseFloat(e.target.value) || 0})} 
              />
            </div>
            <button type="submit" className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20">
              {editingMedicine ? 'Update Item' : 'Create Item'}
            </button>
          </form>
        </Modal>
      )}

      {showExpenseModal && (
        <Modal title={editingExpense ? "Edit Expense" : "New Expense"} onClose={() => {setShowExpenseModal(false); setEditingExpense(null); setNewExpenseData(getDefaultExpenseFormData());}}>
          <form onSubmit={handleCreateExpense} className="space-y-5">
            <Input
              label="Description"
              required
              value={newExpenseData.description || ''}
              onChange={(e: any) => setNewExpenseData({ ...newExpenseData, description: e.target.value })}
              placeholder="e.g., Supplies, Utilities, Rent"
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Category"
                required
                value={newExpenseData.category || ''}
                onChange={(e: any) => setNewExpenseData({ ...newExpenseData, category: e.target.value })}
                placeholder="e.g., Operations"
              />
              <Input
                label={`Amount (${getCurrencySymbol(currency)})`}
                type="number"
                required
                min="0"
                step="0.01"
                value={newExpenseData.amount || 0}
                onChange={(e: any) => setNewExpenseData({ ...newExpenseData, amount: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <Input
              label="Date"
              type="date"
              required
              value={newExpenseData.date || ''}
              onChange={(e: any) => setNewExpenseData({ ...newExpenseData, date: e.target.value })}
            />
            <button type="submit" className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20">
              {editingExpense ? 'Update Expense' : 'Create Expense'}
            </button>
          </form>
        </Modal>
      )}

      {showMedicineSelectionModal && (
        <Suspense fallback={<div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center"><Loader2 className="animate-spin text-white w-10 h-10" /></div>}>
          <MedicineSelectionModal
            medicines={medicines}
            currency={currency}
            onConfirm={handleMedicineSelectionConfirm}
            onClose={() => {
              setShowMedicineSelectionModal(false);
            }}
          />
        </Suspense>
      )}

      {showPaymentCategoryModal && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-xl z-50 flex items-center justify-center p-6 animate-fade-in">
          <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full relative animate-scale-up overflow-hidden">
            <div className="h-2 w-full bg-gradient-to-r from-emerald-400 via-green-500 to-teal-500" />
            <button
              type="button"
              onClick={() => {
                setShowPaymentCategoryModal(false);
                setPaymentServiceFeePreview(null);
                setManualServiceFeeAmount('');
              }}
              className="absolute right-6 top-6 text-gray-300 transition-colors hover:text-gray-900"
            >
              <X size={24} />
            </button>

            <div className="px-8 pt-8 pb-4 text-center">
              <div className="mx-auto mb-4 w-20 h-20 rounded-full bg-gradient-to-br from-emerald-100 to-green-200 flex items-center justify-center shadow-lg shadow-emerald-200">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center">
                  <UserCheck className="w-8 h-8 text-white" />
                </div>
              </div>
              <div className="absolute top-24 left-11 w-2 h-2 rounded-full bg-emerald-300" />
              <div className="absolute top-20 right-14 w-1.5 h-1.5 rounded-full bg-emerald-300" />
              <div className="absolute top-28 right-8 w-1 h-1 rounded-full bg-emerald-400" />

              <h3 className="text-2xl font-black text-gray-900 mb-2">Select Patient Type</h3>
              <p className="text-sm text-emerald-700 font-semibold bg-emerald-50 rounded-full px-4 py-1.5 inline-block">
                Patient type detected automatically before payment collection
              </p>
            </div>

            <div className="mx-8 border-t border-gray-100" />

            <div className="px-8 py-5 space-y-5">
              <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-2xl p-5 border border-emerald-100">
                <p className="text-sm text-gray-600 leading-relaxed">
                  The system checked this patient's previous completed visits and treatment history to decide whether this is a new or old patient.
                </p>
              </div>

              <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-teal-50 p-5 text-left shadow-sm">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-700">
                  {paymentServiceFeePreview?.hasSuggestedFee
                    ? paymentServiceFeePreview.category === 'RETURNING' ? 'Old Patient' : 'New Patient'
                    : 'Manual fee entry'}
                </p>
                <p className="mt-2 text-3xl font-black text-slate-950">
                  {formatCurrency(paymentServiceFeePreview?.feeAmount || 0, currency)}
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  {paymentServiceFeePreview?.hasSuggestedFee
                    ? paymentServiceFeePreview.category === 'RETURNING'
                      ? 'A previous completed visit or treatment was found, so the old-patient service fee is suggested.'
                      : 'No previous completed visit or treatment was found, so the new-patient service fee is suggested.'
                    : 'No automatic service fee is suggested. Enter a manual amount only when an additional charge is required.'}
                </p>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-left">
                <label htmlFor="manual-service-fee" className="block text-sm font-black text-amber-900">
                  Manual service fee for this patient
                </label>
                <p className="mt-1 text-xs font-medium leading-relaxed text-amber-800">
                  Optional. This changes only this payment; clinic service-fee settings and future patients are not changed.
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <input
                    id="manual-service-fee"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={manualServiceFeeAmount}
                    onChange={(event) => setManualServiceFeeAmount(event.target.value)}
                    className="min-w-0 flex-1 rounded-xl border border-amber-300 bg-white px-4 py-3 text-lg font-bold text-slate-950 outline-none transition focus:border-amber-500 focus:ring-4 focus:ring-amber-100"
                    aria-describedby="manual-service-fee-help"
                  />
                  {paymentServiceFeePreview?.hasSuggestedFee ? (
                    <button
                      type="button"
                      onClick={() => setManualServiceFeeAmount(String(paymentServiceFeePreview.feeAmount))}
                      className="rounded-xl border border-amber-300 bg-white px-4 py-3 text-sm font-bold text-amber-900 transition hover:bg-amber-100"
                    >
                      Use default
                    </button>
                  ) : null}
                </div>
                <p id="manual-service-fee-help" className="mt-2 text-xs font-semibold text-amber-800">
                  Enter 0 to waive the fee, a lower amount for hardship, or a higher amount for an additional charge.
                </p>
              </div>
            </div>

            <div className="px-8 pb-8 space-y-3">
              {paymentServiceFeePreview?.hasSuggestedFee && paymentServiceFeePreview.category === 'RETURNING' ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {Math.max(0, clinicalFeeNewPatientAmount) > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setShowPaymentCategoryModal(false);
                          setPaymentServiceFeePreview(null);
                          openPaymentModalWithCategory('RETURNING', Math.max(0, clinicalFeeNewPatientAmount));
                        }}
                        className="w-full px-4 py-3.5 rounded-xl font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-lg shadow-emerald-600/25 transition-all active:scale-[0.98]"
                      >
                        Use Patient Fee {formatCurrency(Math.max(0, clinicalFeeNewPatientAmount), currency)}
                      </button>
                    ) : null}
                    {Math.max(0, clinicalFeeReturningPatientAmount) > 0 && Math.max(0, clinicalFeeReturningPatientAmount) !== Math.max(0, clinicalFeeNewPatientAmount) ? (
                      <button
                        type="button"
                        onClick={() => {
                          setShowPaymentCategoryModal(false);
                          setPaymentServiceFeePreview(null);
                          openPaymentModalWithCategory('RETURNING', Math.max(0, clinicalFeeReturningPatientAmount));
                        }}
                        className="w-full px-4 py-3.5 rounded-xl font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 transition-all active:scale-[0.98]"
                      >
                        Use Old Patient Fee {formatCurrency(Math.max(0, clinicalFeeReturningPatientAmount), currency)}
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowPaymentCategoryModal(false);
                      setPaymentServiceFeePreview(null);
                      setManualServiceFeeAmount('');
                      openPaymentModalWithCategory(null, 0);
                    }}
                    className="w-full px-6 py-3.5 rounded-xl font-bold text-gray-500 bg-gray-100 hover:bg-gray-200 hover:text-gray-700 transition-all active:scale-[0.98]"
                  >
                    Continue Without Service Fee
                  </button>
                </>
              ) : paymentServiceFeePreview?.hasSuggestedFee ? (
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowPaymentCategoryModal(false);
                      setPaymentServiceFeePreview(null);
                      setManualServiceFeeAmount('');
                      openPaymentModalWithCategory(null, 0);
                    }}
                    className="flex-1 px-6 py-3.5 rounded-xl font-bold text-gray-500 bg-gray-100 hover:bg-gray-200 hover:text-gray-700 transition-all active:scale-[0.98]"
                  >
                    Continue Without Service Fee
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const preview = paymentServiceFeePreview;
                      setShowPaymentCategoryModal(false);
                      setPaymentServiceFeePreview(null);
                      setManualServiceFeeAmount('');
                      openPaymentModalWithCategory(preview?.category || null, preview?.feeAmount || 0);
                    }}
                    className="flex-1 px-6 py-3.5 rounded-xl font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-lg shadow-emerald-600/25 transition-all active:scale-[0.98]"
                  >
                    Continue With This Fee
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const preview = paymentServiceFeePreview;
                  const enteredFeeAmount = Number(manualServiceFeeAmount);
                  if (!Number.isFinite(enteredFeeAmount) || enteredFeeAmount < 0) {
                    alert('Manual service fee must be a valid amount of 0 or more.');
                    return;
                  }
                  setShowPaymentCategoryModal(false);
                  setPaymentServiceFeePreview(null);
                  setManualServiceFeeAmount('');
                  openPaymentModalWithCategory(preview?.category || null, enteredFeeAmount);
                }}
                className="w-full rounded-xl bg-amber-600 px-6 py-3.5 font-bold text-white shadow-lg shadow-amber-600/20 transition-all hover:bg-amber-700 active:scale-[0.98]"
              >
                Continue With Manual Fee
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaymentModal && (
        <Modal
          title="Collect Payment"
          maxWidthClassName="max-w-4xl"
          onClose={() => {
            setShowPaymentModal(false);
            paymentSubmitInFlightRef.current = false;
            paymentSubmissionKeyRef.current = null;
            setPaymentDraft({ treatments: [], amountTendered: 0, previousBalance: 0, currentTreatmentTotal: 0, serviceFeeAmount: 0, serviceFeeCategory: null, paymentMethod: 'UNKNOWN', splitPayment: false, allocations: [] });
          }}
        >
          <form onSubmit={handlePaymentSubmit} className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-6">
              <div>
                <p className="text-sm font-semibold text-slate-500">Patient</p>
                <h4 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                  {selectedPatient?.name || 'Unknown Patient'}
                </h4>
                <p className="mt-1 text-sm font-medium text-slate-500">ID: {(() => {
                  const pid = selectedPatient?.patient_unique_id || selectedPatient?.id;
                  if (!pid) return '-';
                  if (pid.length <= 5) return pid;
                  return <>{pid.substring(0, 5)}... <span className="text-indigo-400 hover:underline cursor-pointer" onClick={() => alert(pid)}>see more</span></>;
                })()}</p>
              </div>

              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <p className="text-sm font-semibold text-slate-500">Current total due</p>
                <p className="mt-2 text-4xl font-black tracking-tight text-slate-950">
                  {formatCurrency(paymentOriginalAmount, currency)}
                </p>
                {paymentServiceFeeAmount > 0 ? (
                  <p className="mt-2 text-xs font-semibold text-emerald-700">
                    Includes {paymentServiceFeeLabel} {formatCurrency(paymentServiceFeeAmount, currency)}
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-500">Previous balance</p>
                  <p className="mt-1 text-base font-black leading-tight text-slate-900 sm:text-lg">
                    {formatCurrency(paymentPreviousBalance, currency)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-500">Current treatment</p>
                  <p className="mt-1 text-base font-black leading-tight text-slate-900 sm:text-lg">
                    {formatCurrency(paymentCurrentTreatmentTotal, currency)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-500">Service fee</p>
                  <p className="mt-1 text-base font-black leading-tight text-slate-900 sm:text-lg">
                    {formatCurrency(paymentServiceFeeAmount, currency)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-500">Applied to balance</p>
                  <p className="mt-1 text-base font-black leading-tight text-slate-900 sm:text-lg">
                    {formatCurrency(paymentClearedAmount, currency)}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                  <p className="font-semibold text-slate-500">New balance</p>
                  <p className="mt-1 text-base font-black leading-tight text-slate-900 sm:text-lg">
                    {formatCurrency(Math.max(0, paymentOriginalAmount - paymentClearedAmount), currency)}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <label className="block">
                <span className="mb-2 block text-sm font-bold text-slate-700">
                  Amount received ({getCurrencySymbol(currency)})
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  max={paymentOriginalAmount || undefined}
                  autoFocus
                  disabled={isSubmitting}
                  value={paymentAmountTendered}
                  onChange={(e: any) => {
                    const rawValue = Number.parseFloat(e.target.value);
                    const normalizedValue = Number.isFinite(rawValue) ? rawValue : 0;
                    setPaymentDraft((prev) => ({
                      ...prev,
                      amountTendered: Math.max(0, Math.min(paymentOriginalAmount, normalizedValue)),
                      allocations: prev.splitPayment && prev.allocations.length === 2
                        ? [prev.allocations[0], { ...prev.allocations[1], amount: Math.max(0, Math.min(paymentOriginalAmount, normalizedValue) - Number(prev.allocations[0].amount || 0)) }]
                        : prev.allocations
                    }));
                  }}
                  className="payment-flat-number-input w-full rounded-2xl border border-slate-300 bg-white px-5 py-5 text-4xl font-black tracking-tight text-slate-950 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                />
              </label>

              <fieldset>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <legend className="block text-sm font-bold text-slate-700">Payment type</legend>
                  {splitPaymentsAvailable ? (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => setPaymentDraft((prev) => ({
                      ...prev,
                      splitPayment: !prev.splitPayment,
                      paymentMethod: !prev.splitPayment ? 'MIXED' : 'UNKNOWN',
                      allocations: !prev.splitPayment
                        ? [{ method: 'CASH', amount: Math.round(prev.amountTendered / 2 * 100) / 100 }, { method: 'KPAY', amount: Math.round((prev.amountTendered - prev.amountTendered / 2) * 100) / 100 }]
                        : []
                    }))}
                    className="text-sm font-bold text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                  >
                    {paymentDraft.splitPayment ? 'Use single payment' : '+ Split payment'}
                  </button>
                  ) : null}
                </div>
                {!paymentDraft.splitPayment ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {PAYMENT_METHOD_OPTIONS.map((method) => {
                    const isSelected = paymentDraft.paymentMethod === method.value;
                    return (
                      <button
                        key={method.value}
                        type="button"
                        aria-pressed={isSelected}
                        disabled={isSubmitting}
                        onClick={() => setPaymentDraft((prev) => ({ ...prev, paymentMethod: method.value }))}
                        className={`min-h-12 rounded-xl border px-3 py-2 text-sm font-bold transition ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-100'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        {method.label}
                      </button>
                    );
                  })}
                </div>
                ) : (
                  <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
                    {paymentDraft.allocations.map((allocation, index) => (
                      <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                        <select
                          aria-label={`Payment method ${index + 1}`}
                          value={allocation.method}
                          disabled={isSubmitting}
                          onChange={(event) => setPaymentDraft((prev) => ({
                            ...prev,
                            allocations: prev.allocations.map((item, itemIndex) => itemIndex === index ? { ...item, method: event.target.value as PaymentMethod } : item)
                          }))}
                          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
                        >
                          {PAYMENT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        <input
                          aria-label={`Payment amount ${index + 1}`}
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={allocation.amount || ''}
                          disabled={isSubmitting}
                          onChange={(event) => {
                            const amount = Math.max(0, Number(event.target.value || 0));
                            setPaymentDraft((prev) => ({
                              ...prev,
                              allocations: prev.allocations.map((item, itemIndex) => {
                                if (itemIndex === index) return { ...item, amount };
                                if (itemIndex === prev.allocations.length - 1 && index !== prev.allocations.length - 1) {
                                  const otherTotal = prev.allocations.reduce((sum, candidate, candidateIndex) => candidateIndex === index || candidateIndex === itemIndex ? sum : sum + Number(candidate.amount || 0), 0);
                                  return { ...item, amount: Math.max(0, Math.round((prev.amountTendered - otherTotal - amount) * 100) / 100) };
                                }
                                return item;
                              })
                            }));
                          }}
                          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-right font-bold"
                        />
                        <button
                          type="button"
                          aria-label={`Remove payment allocation ${index + 1}`}
                          disabled={isSubmitting || paymentDraft.allocations.length <= 2}
                          onClick={() => setPaymentDraft((prev) => ({ ...prev, allocations: prev.allocations.filter((_, itemIndex) => itemIndex !== index) }))}
                          className="rounded-xl px-3 text-lg font-bold text-rose-600 disabled:opacity-30"
                        >×</button>
                      </div>
                    ))}
                    {paymentDraft.allocations.length < PAYMENT_METHOD_OPTIONS.length && (
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => setPaymentDraft((prev) => {
                          const nextMethod = PAYMENT_METHOD_OPTIONS.find((option) => !prev.allocations.some((allocation) => allocation.method === option.value))?.value;
                          return nextMethod ? { ...prev, allocations: [...prev.allocations, { method: nextMethod, amount: 0 }] } : prev;
                        })}
                        className="text-sm font-bold text-emerald-700"
                      >+ Add another method</button>
                    )}
                    <div className={`flex justify-between border-t pt-3 text-sm font-bold ${paymentAllocationError ? 'text-rose-700' : 'text-emerald-700'}`}>
                      <span>Allocated {formatCurrency(paymentAllocatedTotal, currency)}</span>
                      <span>{paymentAllocationError ? `Remaining ${formatCurrency(Math.abs(paymentAmountTendered - paymentAllocatedTotal), currency)}` : 'Ready'}</span>
                    </div>
                  </div>
                )}
              </fieldset>

              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-sm font-bold text-emerald-700">Patient pays now</p>
                    <p className="mt-1 text-4xl font-black tracking-tight text-emerald-950">
                      {formatCurrency(paymentAmountTendered, currency)}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-emerald-700">
                    {!paymentAllocationError
                      ? `${paymentDraft.splitPayment ? formatPaymentAllocations(effectivePaymentAllocations) : formatPaymentMethod(paymentDraft.paymentMethod)} · `
                      : 'Select a payment type · '}
                    Balance reduces by {formatCurrency(paymentClearedAmount, currency)}
                  </p>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting || paymentAmountTendered <= 0 || paymentClearedAmount <= 0 || !!paymentAllocationError}
                className="w-full rounded-2xl py-5 text-lg font-black shadow-lg transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: paymentThemeColors.primary,
                  color: paymentThemeColors.onPrimary,
                  boxShadow: `0 18px 36px -18px ${paymentThemeColors.primaryHover}`
                }}
              >
                {isSubmitting ? 'Processing Payment...' : 'Confirm Payment'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showTreatmentSelection && selectedPatient && (
        <Suspense fallback={<div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center"><Loader2 className="animate-spin text-white w-10 h-10" /></div>}>
          <TreatmentSelectionModal
            treatments={treatmentHistory}
            medicines={selectedPatient ? medicineSales.filter((sale) => sale.patient_id === selectedPatient.id) : []}
            currency={currency}
            onConfirm={handleTreatmentSelectionConfirm}
            onClose={() => setShowTreatmentSelection(false)}
          />
        </Suspense>
      )}

      {showReceipt && receiptViewerPatient && (
        <Suspense fallback={<div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center"><Loader2 className="animate-spin text-white w-10 h-10" /></div>}>
          <Receipt
            patient={receiptViewerPatient}
            treatments={selectedTreatmentsForReceipt}
            medicines={selectedMedicineSalesForReceipt}
            paymentAmount={lastPaymentAmount}
            paymentMethod={lastPaymentRecord?.paymentMethod}
            paymentAllocations={lastPaymentRecord?.allocations}
            receiptNumber={lastPaymentRecord?.receiptNumber}
            paymentReceiptSnapshot={activePaymentReceiptSnapshot}
            treatmentTypes={treatmentTypes}
            currency={currency}
            appName={appName}
            receiptHeaderTitle={receiptHeaderTitle}
            receiptInfo={receiptInfo}
            receiptSize={receiptSize}
            onClose={closeReceiptViewer}
          />
        </Suspense>
      )}

      {/* Enhanced Receipt Prompt Dialog - visual upgrade with payment success feedback */}

      {showReceiptPrompt && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-xl z-50 flex items-center justify-center p-6 animate-fade-in">
          <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full relative animate-scale-up overflow-hidden">
            {/* Top accent bar */}
            <div className="h-2 w-full bg-gradient-to-r from-emerald-400 via-green-500 to-teal-500" />

            {/* Success header section */}
            <div className="px-8 pt-8 pb-4 text-center">
              {/* Animated success icon */}
              <div className="mx-auto mb-4 w-20 h-20 rounded-full bg-gradient-to-br from-emerald-100 to-green-200 flex items-center justify-center shadow-lg shadow-emerald-200">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center">
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
              </div>

              {/* Decorative sparkle dots */}
              <div className="absolute top-24 left-11 w-2 h-2 rounded-full bg-emerald-300" />
              <div className="absolute top-20 right-14 w-1.5 h-1.5 rounded-full bg-emerald-300" />
              <div className="absolute top-28 right-8 w-1 h-1 rounded-full bg-emerald-400" />

              <h3 className="text-2xl font-black text-gray-900 mb-2">Payment Collected!</h3>
              <p className="text-sm text-emerald-700 font-semibold bg-emerald-50 rounded-full px-4 py-1.5 inline-block">
                {formatCurrency(lastPaymentAmount, currency)} received via {lastPaymentRecord?.allocations?.length ? formatPaymentAllocations(lastPaymentRecord.allocations) : formatPaymentMethod(lastPaymentRecord?.paymentMethod)}
              </p>
            </div>

            {/* Divider */}
            <div className="mx-8 border-t border-gray-100" />

            {/* Message section */}
            <div className="px-8 py-5">
              <div className="bg-gradient-to-r from-indigo-50 to-blue-50 rounded-2xl p-5 border border-indigo-100">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <p className="text-base font-bold text-gray-900 mb-1">Open Payment Receipt</p>
                    <p className="text-sm text-gray-600 leading-relaxed">
                      Would you like to print or save the payment receipt now? This uses the saved payment snapshot, so future reprints stay accurate.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="px-8 pb-8 flex gap-3">
              <button
                onClick={handleReceiptPromptNo}
                className="flex-1 px-6 py-3.5 rounded-xl font-bold text-gray-500 bg-gray-100 hover:bg-gray-200 hover:text-gray-700 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
                Skip
              </button>
              <button
                onClick={handleReceiptPromptYes}
                className="flex-1 px-6 py-3.5 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-600/25 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Open Receipt
              </button>
            </div>
          </div>
        </div>
      )}


      <ConfirmDialog
        isOpen={deleteServiceConfirmOpen}
        title="Delete Service"
        message={`Are you sure you want to delete "${serviceToDelete?.name}"? Treatment history will be preserved, but this service will no longer be available for new appointments.`}
        confirmText="Delete Service"
        cancelText="Cancel"
        type="danger"
        onConfirm={() => {
          if (serviceToDelete) {
            handleDeleteTreatmentType(serviceToDelete.id);
          }
        }}
        onCancel={() => {
          setServiceToDelete(null);
          setDeleteServiceConfirmOpen(false);
        }}
      />
    </div>
  );
};

export default App;


