import React, { useState, useEffect, useRef, useCallback } from 'react';
import { User, X, Upload, Trash2, FileText, Receipt as ReceiptIcon, Package, RotateCcw, Award, Zap, Key, Edit, Download, Eye, MoreVertical, Calendar, CheckCircle2, AlertCircle, ArrowLeft, Search, Loader2, FileHeart, Printer, WalletCards } from 'lucide-react';
import { ToothSelector } from './ToothSelector';
import { Patient, TreatmentType, ClinicalRecord, PatientFile, LoyaltyTransaction, LoyaltyRule, Doctor, Appointment, TreatmentChargeLine, AppointmentType, Location, MedicineSale, PaymentRecord } from '../types';
import { formatCurrency, getCurrencySymbol, Currency } from '../utils/currency';
import { formatDoctorName as formatDisplayDoctorName } from '../utils/doctorName';
import { formatTeethArray, formatTeethWithPosition, getTeethInQuadrant } from '../utils/toothNumbering';
import { Modal, Input, TimeInput } from './Shared';
import { SearchableSelect } from './SearchableSelect';
import PatientQRScanButton from './PatientQRScanButton';
import { calculateAppointmentShortcutDate, type AppointmentDateShortcut } from '../utils/appointmentDateShortcuts';
import { getNextTreatmentOptionIndex } from '../utils/treatmentSelectorKeyboard';
import { formatMedicineQuantity, getPatientMedicineHistory } from '../utils/medicineHistory';
import { distributeOverallTreatmentDiscount } from '../utils/treatmentDiscount';
import { resolveMedicineSalePricing } from '../utils/medicineSalePricing';
import { formatPaymentAllocations, formatPaymentMethod } from '../utils/paymentMethods';
import { formatPaymentTime, getPatientPaymentHistory, getPaymentBalanceAfter, getPaymentReceiptNumber, getPaymentReceivedAmount } from '../utils/paymentHistory';

const AboutPatientReport = React.lazy(() => import('./AboutPatientReport'));

export interface UploadProgress {
  fileName: string;
  bytesUploaded: number;
  bytesTotal: number;
  percentage: number;
}

interface ClinicalViewProps {
  selectedPatient: Patient | null;
  patients: Patient[];
  locations: Location[];
  doctors: Doctor[];
  selectedDoctorId: string;
  selectedTeeth: number[];
  treatmentTypes: TreatmentType[];
  treatmentHistory: ClinicalRecord[];
  treatmentHistoryLoading?: boolean;
  medicineSales: MedicineSale[];
  medicineHistoryLoading?: boolean;
  medicineHistoryError?: string | null;
  paymentRecords: PaymentRecord[];
  paymentHistoryLoading?: boolean;
  paymentHistoryError?: string | null;
  paymentsAvailable?: boolean;
  patientFiles: PatientFile[];
  uploadingFiles: boolean;
  useFlatRate: boolean;
  currency: Currency;
  onToggleTooth: (id: number) => void;
  onSelectTeeth: (teeth: number[]) => void;
  onDoctorChange: (doctorId: string) => void;
  onDeselectAll: () => void;
  onTreatmentSubmit: (t: TreatmentType, chargeLines?: TreatmentChargeLine[]) => Promise<void>;
  onPaymentRequest: (treatments: ClinicalRecord[]) => void;
  onOpenPaymentReceipt?: (payment: PaymentRecord) => void;
  onServiceFeeRequest?: () => void;
  onClosePatient: () => void;
  onSelectPatient: (patient: Patient) => void;
  onOpenDirectory: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onUploadFilesWithProgress?: (files: File[], onProgress: (progress: UploadProgress) => void) => Promise<void>;
  onDeleteFile: (path: string) => void;
  onGenerateReceipt: () => void;
  onAddMedicines?: () => void;
  onToggleFlatRate: (value: boolean) => void;
  onUndoTreatment?: (record: ClinicalRecord) => void;
  onUndoMedicineSale?: (sale: MedicineSale) => Promise<void>;
  onRedeemPoints?: (points: number, amount: number) => void;
  onUpdatePatient?: (id: string, data: Partial<Patient>) => Promise<void>;
  onUpdateAccount?: (patient: Patient, password: string) => Promise<void>;
  onCreateAppointment?: (data: Partial<Appointment>) => Promise<void>;
  appointments: Appointment[];
  appointmentTypes: AppointmentType[];
  loyaltyEnabled: boolean;
  compactToothSelector?: boolean;
  doctorMobileView?: boolean;
  loyaltyRules?: LoyaltyRule[];
  loyaltyTransactions?: LoyaltyTransaction[];
}

const ClinicalView: React.FC<ClinicalViewProps> = ({
  selectedPatient,
  patients,
  locations,
  doctors,
  selectedDoctorId,
  selectedTeeth,
  treatmentTypes,
  treatmentHistory,
  treatmentHistoryLoading = false,
  medicineSales,
  medicineHistoryLoading = false,
  medicineHistoryError = null,
  paymentRecords,
  paymentHistoryLoading = false,
  paymentHistoryError = null,
  paymentsAvailable = true,
  patientFiles,
  uploadingFiles,
  useFlatRate,
  currency,
  onToggleTooth,
  onSelectTeeth,
  onDoctorChange,
  onDeselectAll,
  onTreatmentSubmit,
  onPaymentRequest,
  onOpenPaymentReceipt,
  onServiceFeeRequest,
  onClosePatient,
  onSelectPatient,
  onOpenDirectory,
  onUploadFiles,
  onUploadFilesWithProgress,
  onDeleteFile,
  onGenerateReceipt,
  onAddMedicines,
  onToggleFlatRate,
  onUndoTreatment,
  onUndoMedicineSale,
  onRedeemPoints,
  onUpdatePatient,
  onUpdateAccount,
  onCreateAppointment,
  appointments,
  appointmentTypes,
  loyaltyEnabled,
  compactToothSelector = false,
  doctorMobileView = false,
  loyaltyRules = [],
  loyaltyTransactions = []
}) => {
  const medicineHistory = React.useMemo(
    () => selectedPatient ? getPatientMedicineHistory(medicineSales, selectedPatient.id) : [],
    [medicineSales, selectedPatient]
  );
  const paymentHistory = React.useMemo(
    () => selectedPatient && paymentsAvailable ? getPatientPaymentHistory(paymentRecords, selectedPatient.id) : [],
    [paymentRecords, paymentsAvailable, selectedPatient]
  );
  const appointmentTypeOptions = React.useMemo(() => {
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

  const getDefaultNextAppointmentDate = () => {
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 7);
    return nextDate.toISOString().split('T')[0];
  };

  const currencySymbol = getCurrencySymbol(currency);
  const outstandingBalance = Math.max(0, Number(selectedPatient?.balance || 0));
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [authModal, setAuthModal] = React.useState(false);
  const [editModal, setEditModal] = React.useState(false);
  const [redeemModal, setRedeemModal] = React.useState(false);
  const [redeemPointsInput, setRedeemPointsInput] = React.useState('');
  const [editData, setEditData] = React.useState({ name: '', email: '', phone: '', medicalHistory: '', location_id: '' });
  const [newPassword, setNewPassword] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<UploadProgress | null>(null);
  const [isUploadingWithProgress, setIsUploadingWithProgress] = React.useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const [deleteModal, setDeleteModal] = React.useState(false);
  const [fileToDelete, setFileToDelete] = React.useState<{name: string, path: string} | null>(null);
  const [treatmentSearchTerm, setTreatmentSearchTerm] = React.useState('');
  const [showTreatmentDropdown, setShowTreatmentDropdown] = React.useState(false);
  const [activeTreatmentIndex, setActiveTreatmentIndex] = React.useState(-1);
  const [currentPage, setCurrentPage] = useState(1);
  const [showNextAppointmentModal, setShowNextAppointmentModal] = React.useState(false);
  const [selectedTreatmentForCharge, setSelectedTreatmentForCharge] = React.useState<TreatmentType | null>(null);
  const [treatmentChargeInputs, setTreatmentChargeInputs] = React.useState<string[]>([]);
  const [overallTreatmentDiscountInput, setOverallTreatmentDiscountInput] = React.useState('0');
  const [isRecordingTreatment, setIsRecordingTreatment] = React.useState(false);
  const [isSavingNextAppointment, setIsSavingNextAppointment] = React.useState(false);
  const [showPatientReport, setShowPatientReport] = React.useState(false);
  const [medicineSaleToDelete, setMedicineSaleToDelete] = React.useState<MedicineSale | null>(null);
  const [deletingMedicineSaleId, setDeletingMedicineSaleId] = React.useState<string | null>(null);
  const [nextAppointmentFeedback, setNextAppointmentFeedback] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [nextAppointmentForm, setNextAppointmentForm] = React.useState<Partial<Appointment>>({
    date: getDefaultNextAppointmentDate(),
    time: '',
    type: '',
    status: 'Scheduled',
    doctor_id: '',
    notes: ''
  });
  React.useEffect(() => {
    setShowPatientReport(false);
    setMedicineSaleToDelete(null);
    setDeletingMedicineSaleId(null);
  }, [selectedPatient?.id]);
  const appointmentTypeOptionsForAppointment = React.useMemo(() => {
    const currentType = (nextAppointmentForm.type || '').trim();
    if (!currentType || appointmentTypeOptions.includes(currentType)) {
      return appointmentTypeOptions;
    }
    return [...appointmentTypeOptions, currentType];
  }, [appointmentTypeOptions, nextAppointmentForm.type]);
  const bookedDoctorName = React.useMemo(() => {
    if (!selectedPatient) return '';
    const patientAppts = appointments.filter(
      (apt) => apt.patient_id === selectedPatient.id && apt.doctor_name?.trim()
    );
    if (patientAppts.length === 0) return '';
    // Sort by date descending (most recent first), then prefer future appointments
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const sorted = [...patientAppts].sort((a, b) => {
      const aFuture = a.date >= todayStr ? 1 : 0;
      const bFuture = b.date >= todayStr ? 1 : 0;
      if (aFuture !== bFuture) return bFuture - aFuture; // future first
      return b.date.localeCompare(a.date) || b.time.localeCompare(a.time);
    });
    return sorted[0].doctor_name?.trim() || '';
  }, [selectedPatient, appointments]);
  const filteredTreatmentTypes = React.useMemo(() => {
    const query = treatmentSearchTerm.trim().toLowerCase();
    if (!query) return treatmentTypes;

    return treatmentTypes.filter((treatment) => {
      const name = (treatment.name || '').toLowerCase();
      const category = (treatment.category || '').toLowerCase();
      return name.includes(query) || category.includes(query);
    });
  }, [treatmentTypes, treatmentSearchTerm]);
  const halfTeeth = React.useMemo(() => ({
    upperAdult: [1, 2].flatMap((quadrant) => getTeethInQuadrant(quadrant)),
    lowerAdult: [3, 4].flatMap((quadrant) => getTeethInQuadrant(quadrant)),
    upperChild: [5, 6].flatMap((quadrant) => getTeethInQuadrant(quadrant, true)),
    lowerChild: [7, 8].flatMap((quadrant) => getTeethInQuadrant(quadrant, true))
  }), []);
  const selectedHalf = (['upperAdult', 'lowerAdult', 'upperChild', 'lowerChild'] as const).find(
    (half) => selectedTeeth.length === halfTeeth[half].length && halfTeeth[half].every((tooth) => selectedTeeth.includes(tooth))
  ) || '';
  const canApplyTreatment = useFlatRate || selectedTeeth.length > 0;
  const treatmentSelectorMessage = React.useMemo(() => {
    if (treatmentTypes.length === 0) {
      return 'No treatments are configured yet. Add services in Treatment Config first.';
    }
    if (!canApplyTreatment) {
      return 'Select teeth first or enable Flat Rate before applying a treatment.';
    }
    if (treatmentSearchTerm.trim() && filteredTreatmentTypes.length === 0) {
      return 'No treatments match your search.';
    }
    return `${filteredTreatmentTypes.length} treatment${filteredTreatmentTypes.length === 1 ? '' : 's'} available`;
  }, [canApplyTreatment, filteredTreatmentTypes.length, treatmentSearchTerm, treatmentTypes.length]);
  const menuRef = useRef<HTMLDivElement>(null);
  const treatmentSelectorRef = useRef<HTMLDivElement>(null);
  const treatmentOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const FILES_PER_PAGE = 3;
  const totalPages = Math.ceil(patientFiles.length / FILES_PER_PAGE);
  const paginatedFiles = patientFiles.slice(
    (currentPage - 1) * FILES_PER_PAGE,
    currentPage * FILES_PER_PAGE
  );

  // Reset to page 1 when files change
  useEffect(() => {
    setCurrentPage(1);
  }, [patientFiles.length]);

  useEffect(() => {
    setShowNextAppointmentModal(false);
    setNextAppointmentFeedback(null);
    setNextAppointmentForm({
      date: getDefaultNextAppointmentDate(),
      time: '',
      type: appointmentTypeOptions[0] || '',
      status: 'Scheduled',
      doctor_id: selectedDoctorId || '',
      notes: ''
    });
  }, [selectedPatient?.id, selectedDoctorId, appointmentTypeOptions]);

  const canRedeem = (selectedPatient?.loyalty_points || 0) > 0;

  // Close dropdown menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
        setMenuPosition(null);
      }
    };

    if (openMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [openMenuId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (treatmentSelectorRef.current && !treatmentSelectorRef.current.contains(event.target as Node)) {
        setShowTreatmentDropdown(false);
      }
    };

    if (showTreatmentDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showTreatmentDropdown]);

  useEffect(() => {
    setActiveTreatmentIndex(-1);
    treatmentOptionRefs.current = [];
  }, [treatmentSearchTerm]);

  useEffect(() => {
    if (activeTreatmentIndex < 0) return;
    treatmentOptionRefs.current[activeTreatmentIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeTreatmentIndex]);

  // Toggle menu for a specific file
  const toggleMenu = useCallback((fileId: string, event?: React.MouseEvent) => {
    if (openMenuId === fileId) {
      setOpenMenuId(null);
      setMenuPosition(null);
    } else {
      setOpenMenuId(fileId);
      // Calculate position based on button element
      if (event?.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPosition({
          top: rect.bottom + 4,
          right: window.innerWidth - rect.right
        });
      }
    }
  }, [openMenuId]);

  const handleRedeemSubmit = () => {
    if (!selectedPatient || !onRedeemPoints) return;

    const availablePoints = selectedPatient.loyalty_points || 0;
    const points = parseInt(redeemPointsInput, 10);

    if (isNaN(points) || points <= 0 || points > availablePoints) {
      alert(`Please enter a valid amount between 1 and ${availablePoints}.`);
      return;
    }

    onRedeemPoints(points, 0);
    setRedeemModal(false);
    setRedeemPointsInput('');
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatDoctorName = (name?: string) => {
    if (!name) return '—';
    const normalizedName = name.trim().replace(/^dr\.?\s*/i, '');
    return normalizedName ? `Dr. ${normalizedName}` : 'â€”';
  };

  const getDefaultTreatmentCost = (treatment: TreatmentType) => {
    const unitCost = Number(treatment.cost || 0);
    return useFlatRate ? unitCost : unitCost * selectedTeeth.length;
  };

  const getTreatmentChargeLines = (treatment: TreatmentType): TreatmentChargeLine[] => {
    const unitCost = Number(treatment.cost || 0);
    if (useFlatRate || selectedTeeth.length <= 1) {
      return [{
        teeth: useFlatRate ? selectedTeeth : selectedTeeth.slice(0, 1),
        cost: useFlatRate ? unitCost : unitCost,
        standardCost: useFlatRate ? unitCost : unitCost
      }];
    }

    return selectedTeeth.map((tooth) => ({
      teeth: [tooth],
      cost: unitCost,
      standardCost: unitCost
    }));
  };

  const selectedTreatmentStandardTotal = selectedTreatmentForCharge
    ? getTreatmentChargeLines(selectedTreatmentForCharge).reduce((sum, line) => sum + line.standardCost, 0)
    : 0;
  const selectedTreatmentLineSubtotal = selectedTreatmentForCharge
    ? treatmentChargeInputs.reduce((sum, value) => {
        const parsedValue = Number.parseFloat(value);
        return sum + (Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0);
      }, 0)
    : 0;
  const parsedOverallTreatmentDiscount = Number.parseFloat(overallTreatmentDiscountInput);
  const overallTreatmentDiscount = Number.isFinite(parsedOverallTreatmentDiscount)
    ? Math.min(selectedTreatmentLineSubtotal, Math.max(0, parsedOverallTreatmentDiscount))
    : 0;
  const selectedTreatmentFinalTotal = Math.max(0, selectedTreatmentLineSubtotal - overallTreatmentDiscount);
  const individualTreatmentDiscount = Math.max(0, selectedTreatmentStandardTotal - selectedTreatmentLineSubtotal);
  const selectedTreatmentTotalDiscount = individualTreatmentDiscount + overallTreatmentDiscount;

  const handleTreatmentSelect = (treatment: TreatmentType) => {
    if (!canApplyTreatment) return;

    const chargeLines = getTreatmentChargeLines(treatment);
    setSelectedTreatmentForCharge(treatment);
    setTreatmentChargeInputs(chargeLines.map((line) => String(line.cost)));
    setOverallTreatmentDiscountInput('0');
    setTreatmentSearchTerm('');
    setShowTreatmentDropdown(false);
  };

  const handleTreatmentSelectorKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setShowTreatmentDropdown(false);
      setActiveTreatmentIndex(-1);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setShowTreatmentDropdown(true);
      setActiveTreatmentIndex((currentIndex) => getNextTreatmentOptionIndex(
        currentIndex,
        filteredTreatmentTypes.length,
        event.key === 'ArrowDown' ? 'down' : 'up'
      ));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const treatment = filteredTreatmentTypes[activeTreatmentIndex];
      if (treatment) handleTreatmentSelect(treatment);
    }
  };

  const handleChargeModalClose = () => {
    if (isRecordingTreatment) return;
    setSelectedTreatmentForCharge(null);
    setTreatmentChargeInputs([]);
    setOverallTreatmentDiscountInput('0');
  };

  const handleConfirmTreatmentCharge = async () => {
    if (!selectedTreatmentForCharge) return;

    let chargeLines: TreatmentChargeLine[];
    try {
      const baseChargeLines = getTreatmentChargeLines(selectedTreatmentForCharge);
      chargeLines = baseChargeLines.map((line, index) => {
        const parsedCost = Number.parseFloat(treatmentChargeInputs[index] || '');
        if (!Number.isFinite(parsedCost) || parsedCost < 0) {
          throw new Error('Please enter a valid treatment charge of 0 or more for every treatment line.');
        }

        return {
          ...line,
          cost: Math.max(0, parsedCost)
        };
      });
      chargeLines = distributeOverallTreatmentDiscount(chargeLines, overallTreatmentDiscount);
    } catch (error: any) {
      alert(error?.message || 'Please enter valid treatment charges.');
      return;
    }

    setIsRecordingTreatment(true);
    try {
      await onTreatmentSubmit(selectedTreatmentForCharge, chargeLines);
      handleChargeModalClose();
    } catch {
      // App-level error handling already surfaced the failure.
    } finally {
      setIsRecordingTreatment(false);
    }
  };

  const handleQuickDateApply = (shortcut: AppointmentDateShortcut) => {
    setNextAppointmentForm((prev) => ({
      ...prev,
      date: calculateAppointmentShortcutDate(shortcut)
    }));
  };

  const handleCreateNextAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPatient || !onCreateAppointment) return;

    if (!nextAppointmentForm.date || !nextAppointmentForm.time) {
      setNextAppointmentFeedback({
        type: 'error',
        message: 'Date and time are required to schedule the next appointment.'
      });
      return;
    }

    setIsSavingNextAppointment(true);
    setNextAppointmentFeedback(null);
    try {
      await onCreateAppointment({
        ...nextAppointmentForm,
        patient_id: selectedPatient.id,
        status: 'Scheduled'
      });
      setNextAppointmentFeedback({
        type: 'success',
        message: 'Next appointment created. It is now visible in the Appointments tab.'
      });
      setShowNextAppointmentModal(false);
      setNextAppointmentForm({
        date: getDefaultNextAppointmentDate(),
        time: '',
        type: appointmentTypeOptions[0] || '',
        status: 'Scheduled',
        doctor_id: selectedDoctorId || '',
        notes: ''
      });
    } catch (error: any) {
      setNextAppointmentFeedback({
        type: 'error',
        message: error?.message || 'Could not create the appointment. Please check the details and try again.'
      });
    } finally {
      setIsSavingNextAppointment(false);
    }
  };

  const allowedFile = (file: File) => {
    const allowedTypes = [
      'image/',
      'application/pdf',
      'video/',
      'application/zip',
      'application/x-zip-compressed',
      'multipart/x-zip'
    ];
    return allowedTypes.some(type => 
      type.endsWith('/') ? file.type.startsWith(type) : file.type === type
    );
  };

  const handleUpload = async (files: File[]) => {
    const filtered = files.filter(allowedFile);
    if (filtered.length === 0) return;

    // Use chunked upload with progress if available
    if (onUploadFilesWithProgress) {
      setIsUploadingWithProgress(true);
      setUploadProgress(null);
      try {
        await onUploadFilesWithProgress(filtered, (progress) => {
          setUploadProgress(progress);
        });
      } catch (err: any) {
        // Show detailed error message
        const errorMessage = err.message || 'Upload failed';
        console.error('[ClinicalView] Upload error:', err);
        
        // Check for specific error types
        if (errorMessage.includes('413') || errorMessage.includes('too large')) {
          alert(`File "${filtered[0]?.name}" is too large for the storage bucket.\n\nPlease contact support to increase the file size limit, or try a smaller file.`);
        } else if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
          alert(`Upload timed out for "${filtered[0]?.name}".\n\nThis could be due to:\n- Slow or unstable network connection\n- Server timeout settings\n\nPlease try again with a smaller file or check your network connection.`);
        } else if (errorMessage.includes('403') || errorMessage.includes('permission')) {
          alert(`Permission denied for "${filtered[0]?.name}".\n\nPlease check your storage bucket permissions.`);
        } else {
          alert(`Upload failed for "${filtered[0]?.name}":\n\n${errorMessage}\n\nPlease try again or contact support if the issue persists.`);
        }
      } finally {
        setIsUploadingWithProgress(false);
        setUploadProgress(null);
      }
    } else {
      // Fallback to regular upload
      onUploadFiles(filtered);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) handleUpload(files);
  };

  const handleBrowse = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length) {
      handleUpload(Array.from(files));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
  <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-6 animate-fade-in max-w-full">
    <div className="xl:col-span-2 space-y-4 md:space-y-6 min-w-0">
      <div className={`bg-white rounded-xl shadow-sm border border-gray-100 ${compactToothSelector ? 'p-3 md:p-4' : 'p-4 md:p-6'}`}>
        <div className={`flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center ${compactToothSelector ? 'mb-3' : 'mb-6'}`}>
          <div>
            <h2 className="text-xl font-bold text-gray-800">Odontogram Interface</h2>
            <p className="text-sm text-gray-500">Interactive tooth mapping and service delivery</p>
          </div>
          <PatientQRScanButton
            patients={patients}
            onSelectPatient={onSelectPatient}
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
          />
        </div>
        
        <div className={`flex justify-center w-full overflow-x-auto custom-scrollbar ${compactToothSelector ? 'pb-2' : 'pb-4'}`}>
          <div className={`${doctorMobileView ? 'w-full min-w-full' : compactToothSelector ? 'min-w-[300px] md:min-w-[390px]' : 'min-w-[400px] md:min-w-[600px]'} max-w-full`}>
            <ToothSelector 
              selectedTeeth={selectedTeeth} 
              onToggleTooth={onToggleTooth} 
              onDeselectAll={onDeselectAll} 
              compact={compactToothSelector}
              doctorCompact={doctorMobileView}
            />
          </div>
        </div>
        {bookedDoctorName && (
          <div className="mx-4 mt-2 mb-1 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">Booked Doctor</p>
                <p className="text-sm font-black text-indigo-900">{formatDoctorName(bookedDoctorName)}</p>
              </div>
            </div>
          </div>
        )}
        
        {selectedPatient && (
          <div className="mt-6 p-4 md:p-5 bg-indigo-50 rounded-lg border border-indigo-100">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
              <h4 className="font-bold text-indigo-900 leading-tight">
                {selectedTeeth.length > 0 ? `Apply to Teeth: ${formatTeethArray(selectedTeeth)}` : 'Select Teeth to Perform Treatment'}
              </h4>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className={`flex items-center gap-3 cursor-pointer self-start sm:self-auto rounded-2xl border px-5 py-3 shadow-sm transition ${
                  useFlatRate
                    ? 'border-indigo-600 bg-indigo-600 text-white shadow-indigo-200'
                    : 'border-indigo-200 bg-white text-indigo-900 hover:border-indigo-400 hover:bg-indigo-50'
                }`}>
                  <input
                    type="checkbox"
                    checked={useFlatRate}
                    onChange={(e) => onToggleFlatRate(e.target.checked)}
                    aria-label="Apply treatment to all teeth"
                    className="w-5 h-5 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                  />
                  <span className="text-base font-black">
                    ALL TEETH
                  </span>
                </label>
                <select
                  value={selectedHalf}
                  onChange={(e) => {
                    if (!e.target.value) {
                      onSelectTeeth([]);
                      onToggleFlatRate(false);
                      return;
                    }
                    onSelectTeeth(halfTeeth[e.target.value as keyof typeof halfTeeth]);
                    onToggleFlatRate(true);
                  }}
                  className="rounded-2xl border border-indigo-200 bg-white px-5 py-3 text-base font-black text-indigo-900 shadow-sm outline-none transition hover:border-indigo-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                  aria-label="Apply treatment to half teeth"
                >
                  <option value="">{selectedHalf ? 'Clear Half Teeth' : 'HALF TEETH'}</option>
                  <option value="upperAdult">Upper (Adult)</option>
                  <option value="lowerAdult">Lower (Adult)</option>
                  <option value="upperChild">Upper (Child)</option>
                  <option value="lowerChild">Lower (Child)</option>
                </select>
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-[10px] text-indigo-700 uppercase font-bold tracking-wider mb-1.5">Treating Doctor</label>
              <SearchableSelect
                value={selectedDoctorId}
                onChange={onDoctorChange}
                options={[
                  { value: '', label: 'Select doctor (optional)' },
                  ...doctors.map((doctor) => ({
                    value: doctor.id,
                    label: `${formatDoctorName(doctor.name)}${doctor.specialization ? ` - ${doctor.specialization}` : ''}`
                  }))
                ]}
                placeholder="Select doctor (optional)"
                emptyMessage="No doctors found"
              />
            </div>
            <div className="relative" ref={treatmentSelectorRef}>
              <label className="block text-[10px] text-indigo-700 uppercase font-bold tracking-wider mb-1.5">Select Treatment</label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-indigo-300" />
                <input
                  type="search"
                  value={treatmentSearchTerm}
                  disabled={treatmentTypes.length === 0}
                  onChange={(e) => {
                    setTreatmentSearchTerm(e.target.value);
                    setShowTreatmentDropdown(true);
                  }}
                  onFocus={() => {
                    if (treatmentTypes.length > 0) setShowTreatmentDropdown(true);
                  }}
                  onKeyDown={handleTreatmentSelectorKeyDown}
                  placeholder="Search by treatment name or category..."
                  className="w-full rounded-xl border border-indigo-200 bg-white py-2.5 pl-10 pr-24 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
                  aria-label="Search treatments"
                  aria-describedby="treatment-selector-message"
                  aria-autocomplete="list"
                  aria-controls="treatment-options"
                  aria-expanded={showTreatmentDropdown}
                  aria-activedescendant={activeTreatmentIndex >= 0 ? `treatment-option-${filteredTreatmentTypes[activeTreatmentIndex]?.id}` : undefined}
                  role="combobox"
                />
                <button
                  type="button"
                  disabled={treatmentTypes.length === 0}
                  onClick={() => setShowTreatmentDropdown((open) => !open)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-expanded={showTreatmentDropdown}
                  aria-label="Open treatment dropdown"
                >
                  {treatmentSearchTerm.trim() ? filteredTreatmentTypes.length : 'All'}
                </button>
                {treatmentSearchTerm && (
                  <button
                    type="button"
                    onClick={() => {
                      setTreatmentSearchTerm('');
                      setShowTreatmentDropdown(true);
                    }}
                    className="absolute right-14 top-1/2 -translate-y-1/2 rounded-lg p-1 text-gray-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
                    aria-label="Clear treatment search"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <p
                id="treatment-selector-message"
                className={`mt-1.5 text-xs font-semibold ${
                  treatmentTypes.length === 0 || !canApplyTreatment || filteredTreatmentTypes.length === 0
                    ? 'text-amber-700'
                    : 'text-indigo-700'
                }`}
              >
                {treatmentSelectorMessage}
              </p>
              {showTreatmentDropdown && (
                <div className="absolute left-0 right-0 top-full z-40 mt-2 rounded-xl border border-indigo-100 bg-white shadow-xl">
                  <div className="flex items-center justify-between gap-3 border-b border-indigo-50 px-3 py-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-indigo-500">
                      Treatments
                    </span>
                    <span className="text-xs font-bold text-gray-500">
                      {filteredTreatmentTypes.length} of {treatmentTypes.length}
                    </span>
                  </div>
                  <div id="treatment-options" role="listbox" className="max-h-80 overflow-y-auto p-2 custom-scrollbar">
                    {filteredTreatmentTypes.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-indigo-100 bg-indigo-50 px-3 py-4 text-center text-sm font-semibold text-indigo-700">
                        No treatments match your search.
                      </div>
                    ) : (
                      filteredTreatmentTypes.map((t, index) => {
                        const displayCost = useFlatRate
                          ? t.cost
                          : (t.cost * (selectedTeeth.length || 1));
                        const costLabel = useFlatRate
                          ? `${formatCurrency(t.cost, currency)} flat rate`
                          : `${formatCurrency(t.cost, currency)} / tooth`;
                        const isDisabled = !useFlatRate && selectedTeeth.length === 0;

                        return (
                          <button
                            key={t.id}
                            id={`treatment-option-${t.id}`}
                            ref={(element) => { treatmentOptionRefs.current[index] = element; }}
                            type="button"
                            role="option"
                            aria-selected={index === activeTreatmentIndex}
                            disabled={isDisabled}
                            onClick={() => handleTreatmentSelect(t)}
                            onMouseEnter={() => setActiveTreatmentIndex(index)}
                            className={`flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-row sm:items-center sm:justify-between sm:gap-3 ${index === activeTreatmentIndex ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-200' : ''}`}
                          >
                            <span className="min-w-0">
                              <span className="block break-words text-sm font-bold text-gray-900">{t.name}</span>
                              {t.category && (
                                <span className="block break-words text-xs font-medium text-gray-400">{t.category}</span>
                              )}
                            </span>
                            <span className="shrink-0 text-left text-xs font-bold text-indigo-700 sm:text-right">
                              {costLabel}
                              {!useFlatRate && selectedTeeth.length > 0 && (
                                <span className="block text-green-700">Total: {formatCurrency(displayCost, currency)}</span>
                              )}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                  {!useFlatRate && selectedTeeth.length === 0 && (
                    <div className="border-t border-indigo-50 px-3 py-2 text-xs font-semibold text-amber-700">
                      Select teeth first or enable Flat Rate.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {selectedPatient && (
        <div className="overflow-hidden rounded-xl border border-violet-100 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-violet-100 bg-gradient-to-r from-violet-50 via-fuchsia-50/60 to-white px-5 py-5 sm:flex-row sm:items-center sm:justify-between md:px-7">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm shadow-violet-200">
                <FileHeart size={19} aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xl font-black text-gray-900">Clinical Case History</h3>
                <p className="mt-0.5 text-sm text-violet-800">Treatments, clinicians, teeth, and recorded fees.</p>
              </div>
            </div>
            <span className="w-fit rounded-full bg-white px-3 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200">
              {treatmentHistoryLoading ? 'Loading…' : `${treatmentHistory.length} ${treatmentHistory.length === 1 ? 'record' : 'records'}`}
            </span>
          </div>
          <div className="max-h-[34rem] min-h-[18rem] overflow-auto custom-scrollbar">
            <table className="w-full min-w-[48rem] text-left text-[15px]">
              <thead className="sticky top-0 border-b border-violet-100 bg-violet-50/90 text-xs uppercase tracking-wide text-violet-700 backdrop-blur-sm">
                <tr>
                  <th className="px-5 py-4">Date</th>
                  <th className="px-5 py-4">Doctor</th>
                  <th className="px-5 py-4">Anatomy (Teeth)</th>
                  <th className="px-5 py-4">Service Provided</th>
                  <th className="px-5 py-4 text-right">Fee</th>
                  <th className="px-5 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-violet-50">
                {treatmentHistoryLoading ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center" role="status" aria-live="polite">
                      <Loader2 className="mx-auto mb-3 animate-spin text-violet-500" size={30} aria-hidden="true" />
                      <p className="font-semibold text-gray-600">Loading clinical case history…</p>
                      <div className="mx-auto mt-4 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-violet-100" aria-hidden="true">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-violet-500" />
                      </div>
                      <p className="mt-2 text-xs text-gray-400">Please wait while patient records are retrieved.</p>
                    </td>
                  </tr>
                ) : treatmentHistory.length === 0 ? (
                  <tr><td colSpan={7} className="px-5 py-12 text-center text-gray-400 italic">No clinical history recorded for this patient.</td></tr>
                ) : (
                  treatmentHistory.map((rec) => (
                    <tr key={rec.id} className="transition-colors hover:bg-violet-50/50">
                      <td className="px-5 py-4 text-gray-600 whitespace-nowrap">{rec.date}</td>
                      <td className="px-5 py-4 text-gray-800 font-semibold whitespace-nowrap">{formatDoctorName(rec.doctor_name)}</td>
                      <td className="px-5 py-4">
                        <span className="inline-block rounded bg-violet-50 px-2 py-1 text-sm leading-relaxed text-violet-800 ring-1 ring-violet-100">
                          {formatTeethWithPosition(rec.teeth)}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-semibold text-gray-900">{rec.description}</td>
                      <td className="px-5 py-4 text-right font-black text-gray-900 whitespace-nowrap">{formatCurrency(rec.cost || 0, currency)}</td>
                      <td className="px-5 py-4 text-center">
                        {onUndoTreatment && (
                          <button 
                            onClick={() => onUndoTreatment(rec)}
                            className="rounded-lg p-2 text-violet-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                            title="Undo/Delete Record"
                          >
                            <RotateCcw size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedPatient && (
        <div className="overflow-hidden rounded-xl border border-emerald-100 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-emerald-100 bg-emerald-50/70 px-5 py-5 sm:flex-row sm:items-center sm:justify-between md:px-7">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
                <Package size={19} aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xl font-black text-gray-900">Medicine History</h3>
                <p className="mt-0.5 text-sm text-emerald-800">Medicines and inventory items given to this patient.</p>
              </div>
            </div>
            <span className="w-fit rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
              {medicineHistoryLoading ? 'Loading…' : `${medicineHistory.length} ${medicineHistory.length === 1 ? 'record' : 'records'}`}
            </span>
          </div>

          <div className="max-h-[28rem] min-h-[12rem] overflow-auto custom-scrollbar">
            <table className="w-full min-w-[42rem] text-left text-[15px]">
              <thead className="sticky top-0 border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-4 md:px-7">Date</th>
                  <th className="px-5 py-4">Medicine / Item</th>
                  <th className="px-5 py-4">Quantity given</th>
                  <th className="px-5 py-4 text-right">Unit price</th>
                  <th className="px-5 py-4 text-right">Total</th>
                  {onUndoMedicineSale && <th className="px-5 py-4 text-center md:pr-7">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {medicineHistoryLoading ? (
                  <tr>
                    <td colSpan={onUndoMedicineSale ? 6 : 5} className="px-5 py-12 text-center md:px-7" role="status" aria-live="polite">
                      <Loader2 className="mx-auto mb-3 animate-spin text-emerald-500" size={30} aria-hidden="true" />
                      <p className="font-semibold text-gray-600">Loading medicine history…</p>
                      <div className="mx-auto mt-4 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-emerald-100" aria-hidden="true">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-emerald-500" />
                      </div>
                      <p className="mt-2 text-xs text-gray-400">Please wait while medicine records are retrieved.</p>
                    </td>
                  </tr>
                ) : medicineHistoryError ? (
                  <tr>
                    <td colSpan={onUndoMedicineSale ? 6 : 5} className="px-5 py-12 text-center md:px-7">
                      <AlertCircle className="mx-auto mb-3 text-red-400" size={32} aria-hidden="true" />
                      <p className="font-semibold text-red-700">Medicine history could not be loaded.</p>
                      <p className="mt-1 text-sm text-gray-500">{medicineHistoryError}</p>
                    </td>
                  </tr>
                ) : medicineHistory.length === 0 ? (
                  <tr>
                    <td colSpan={onUndoMedicineSale ? 6 : 5} className="px-5 py-12 text-center md:px-7">
                      <Package className="mx-auto mb-3 text-emerald-200" size={34} aria-hidden="true" />
                      <p className="font-semibold text-gray-500">No medicine records for this patient yet.</p>
                      <p className="mt-1 text-sm text-gray-400">Items added to the patient’s bill will appear here.</p>
                    </td>
                  </tr>
                ) : medicineHistory.map((sale) => {
                  const pricing = resolveMedicineSalePricing(sale as MedicineSale & Record<string, unknown>);
                  return (
                  <tr key={sale.id} className="transition-colors hover:bg-emerald-50/30">
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600 md:px-7">{sale.date}</td>
                    <td className="px-5 py-4 font-semibold text-gray-900">{sale.medicine_name || 'Inventory item'}</td>
                    <td className="px-5 py-4">
                      <span className="inline-flex rounded-lg bg-emerald-50 px-2.5 py-1 text-sm font-bold text-emerald-800">
                        {formatMedicineQuantity(sale.quantity, sale.medicine_unit)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-right text-gray-600">{formatCurrency(Number(sale.unit_price || 0), currency)}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-right font-black text-gray-900 md:pr-7">
                      {pricing.discountAmount > 0 && <div className="text-xs font-medium text-gray-400 line-through">{formatCurrency(pricing.standardTotal, currency)}</div>}
                      <div>{formatCurrency(pricing.finalTotal, currency)}</div>
                      {pricing.note && <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${pricing.note === 'FOC' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>{pricing.note}</span>}
                    </td>
                    {onUndoMedicineSale && (
                      <td className="px-5 py-4 text-center md:pr-7">
                        <button
                          type="button"
                          onClick={() => setMedicineSaleToDelete(sale)}
                          disabled={deletingMedicineSaleId === sale.id}
                          className="rounded-lg p-2 text-emerald-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-50"
                          title="Undo/Delete Medicine Record"
                          aria-label={`Delete ${sale.medicine_name || 'medicine'} record`}
                        >
                          {deletingMedicineSaleId === sale.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </button>
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedPatient && paymentsAvailable && (
        <div className="overflow-hidden rounded-xl border border-violet-100 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-violet-100 bg-violet-50/70 px-5 py-5 sm:flex-row sm:items-center sm:justify-between md:px-7">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm shadow-violet-200">
                <WalletCards size={19} aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xl font-black text-gray-900">Payment History</h3>
                <p className="mt-0.5 text-sm text-violet-800">Payments and receipt records for this patient only.</p>
              </div>
            </div>
            <span className="w-fit rounded-full bg-white px-3 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200">
              {paymentHistoryLoading ? 'Loading…' : `${paymentHistory.length} ${paymentHistory.length === 1 ? 'payment' : 'payments'}`}
            </span>
          </div>

          <div className="max-h-[28rem] min-h-[12rem] overflow-auto custom-scrollbar">
            <table className="w-full min-w-[62rem] text-left text-[15px]">
              <thead className="sticky top-0 border-b border-violet-100 bg-violet-50/90 text-xs uppercase tracking-wide text-violet-700 backdrop-blur-sm">
                <tr>
                  <th className="px-5 py-4 md:px-7">Date</th>
                  <th className="px-5 py-4">Receipt</th>
                  <th className="px-5 py-4">Payment method</th>
                  <th className="px-5 py-4">Recorded by</th>
                  <th className="px-5 py-4 text-right">Amount received</th>
                  <th className="px-5 py-4 text-right">Balance after</th>
                  <th className="px-5 py-4 text-center md:pr-7">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-violet-50">
                {paymentHistoryLoading ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center md:px-7" role="status" aria-live="polite">
                      <Loader2 className="mx-auto mb-3 animate-spin text-violet-500" size={30} aria-hidden="true" />
                      <p className="font-semibold text-gray-600">Loading payment history…</p>
                      <div className="mx-auto mt-4 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-violet-100" aria-hidden="true">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-violet-500" />
                      </div>
                      <p className="mt-2 text-xs text-gray-400">Please wait while payment records are retrieved.</p>
                    </td>
                  </tr>
                ) : paymentHistoryError ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center md:px-7">
                      <AlertCircle className="mx-auto mb-3 text-red-400" size={32} aria-hidden="true" />
                      <p className="font-semibold text-red-700">Payment history could not be loaded.</p>
                      <p className="mt-1 text-sm text-gray-500">{paymentHistoryError}</p>
                    </td>
                  </tr>
                ) : paymentHistory.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center md:px-7">
                      <WalletCards className="mx-auto mb-3 text-violet-200" size={34} aria-hidden="true" />
                      <p className="font-semibold text-gray-500">No payment records for this patient yet.</p>
                      <p className="mt-1 text-sm text-gray-400">Completed patient payments will appear here.</p>
                    </td>
                  </tr>
                ) : paymentHistory.map((payment) => {
                  const isVoided = Boolean(payment.voidedAt);
                  const paymentMethod = payment.allocations?.length
                    ? formatPaymentAllocations(payment.allocations)
                    : formatPaymentMethod(payment.paymentMethod);
                  const receiptNumber = getPaymentReceiptNumber(payment);
                  const paymentTime = formatPaymentTime(payment.createdAt);

                  return (
                    <tr key={payment.id} className={`transition-colors ${isVoided ? 'bg-red-50/40 hover:bg-red-50/70' : 'hover:bg-violet-50/40'}`}>
                      <td className="whitespace-nowrap px-5 py-4 text-gray-600 md:px-7">
                        <div className="font-semibold text-gray-800">{payment.date}</div>
                        {paymentTime && <div className="mt-0.5 text-xs text-gray-400">{paymentTime}</div>}
                      </td>
                      <td className="px-5 py-4">
                        <span className="inline-flex rounded-lg bg-violet-50 px-2.5 py-1 text-sm font-bold text-violet-800 ring-1 ring-violet-100">{receiptNumber}</span>
                        {payment.corrections?.length ? (
                          <span className="mt-2 block text-xs font-bold text-amber-700">Corrected by Admin · {payment.corrections.length} {payment.corrections.length === 1 ? 'change' : 'changes'}</span>
                        ) : null}
                        {isVoided ? (
                          <span className="mt-2 block text-xs font-black text-red-700">VOID · {payment.voidReason || 'Payment reversed'}</span>
                        ) : null}
                      </td>
                      <td className="px-5 py-4 font-semibold text-gray-800">{paymentMethod}</td>
                      <td className="px-5 py-4 text-gray-600">{payment.createdByUserName || payment.receiptSnapshot?.payment.recordedByUserName || 'Unknown'}</td>
                      <td className={`whitespace-nowrap px-5 py-4 text-right font-black ${isVoided ? 'text-red-700' : 'text-violet-700'}`}>{isVoided ? `VOID (${formatCurrency(payment.voidedAmount ?? payment.originalAmount ?? 0, currency)})` : formatCurrency(getPaymentReceivedAmount(payment), currency)}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-right font-bold text-gray-900">{formatCurrency(getPaymentBalanceAfter(payment), currency)}</td>
                      <td className="px-5 py-4 text-center md:pr-7">
                        {onOpenPaymentReceipt && !isVoided ? (
                          <button
                            type="button"
                            onClick={() => onOpenPaymentReceipt(payment)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-700 transition-colors hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                            aria-label={`Reprint receipt ${receiptNumber}`}
                          >
                            <Printer size={14} aria-hidden="true" /> Reprint Receipt
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Unavailable</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {medicineSaleToDelete && onUndoMedicineSale && (
        <Modal title="Delete Medicine Record" closeDisabled={!!deletingMedicineSaleId} onClose={() => setMedicineSaleToDelete(null)}>
          <div className="space-y-5">
            <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-900">
              <p className="font-black">Undo {medicineSaleToDelete.medicine_name || 'this inventory item'}?</p>
              <p className="mt-1 text-red-700">This restores {formatMedicineQuantity(medicineSaleToDelete.quantity, medicineSaleToDelete.medicine_unit)} to stock and reverses its patient balance and loyalty effects. Paid or receipted records cannot be deleted.</p>
            </div>
            <div className="flex gap-3">
              <button type="button" disabled={!!deletingMedicineSaleId} onClick={() => setMedicineSaleToDelete(null)} className="flex-1 rounded-xl border border-gray-300 py-3 font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
              <button
                type="button"
                disabled={!!deletingMedicineSaleId}
                onClick={async () => {
                  setDeletingMedicineSaleId(medicineSaleToDelete.id);
                  try {
                    await onUndoMedicineSale(medicineSaleToDelete);
                    setMedicineSaleToDelete(null);
                  } catch {
                    // App-level handling displays the database safety message.
                  } finally {
                    setDeletingMedicineSaleId(null);
                  }
                }}
                className="flex-1 rounded-xl bg-red-600 py-3 font-bold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-50"
              >
                {deletingMedicineSaleId ? 'Deleting…' : 'Delete Record'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>

    <div className="space-y-6 h-fit">
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold text-gray-800">Patient Brief</h3>
          {selectedPatient && (
            <button
              onClick={onOpenDirectory}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-100"
            >
              <ArrowLeft size={14} />
              Back to Patients
            </button>
          )}
        </div>
        {selectedPatient ? (
          <div className="space-y-6">
             <button
               type="button"
               onClick={() => setShowPatientReport(true)}
               className="flex w-full items-center justify-between gap-3 rounded-xl bg-slate-950 px-4 py-3 text-left text-white shadow-sm transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2"
             >
               <span className="flex items-center gap-3">
                 <span className="rounded-lg bg-cyan-300 p-2 text-slate-950"><FileHeart size={18} /></span>
                 <span><span className="block text-sm font-black">About this patient</span><span className="block text-[11px] text-slate-300">Open visits, care, medicine and payment report</span></span>
               </span>
               <Eye size={18} className="shrink-0 text-cyan-300" />
             </button>
             <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-full bg-indigo-100 flex items-center justify-center text-xl font-bold text-indigo-700">
                  {selectedPatient.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-bold text-gray-900 leading-tight">{selectedPatient.name}</h4>
                  <p className="text-xs text-gray-500 mt-1">{selectedPatient.phone}</p>
                </div>
              </div>
             <div className="grid grid-cols-1 gap-3">
               <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                 <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider mb-1">Outstanding Balance</p>
                  <div className="flex justify-between items-baseline gap-3">
                     <p className={`text-xl font-black ${outstandingBalance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {formatCurrency(selectedPatient.balance || 0, currency)}
                    </p>
                     {outstandingBalance > 0 ? (
                      <button
                        onClick={() => onPaymentRequest(treatmentHistory)}
                        className="bg-green-600 hover:bg-green-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm"
                      >
                        Collect Payment
                      </button>
                     ) : onServiceFeeRequest ? (
                       <button
                         onClick={onServiceFeeRequest}
                         className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm"
                       >
                         Wanna add service fees?
                       </button>
                     ) : null}
                 </div>
               </div>

               {selectedPatient && onCreateAppointment && (
                 <div className="rounded-xl border border-indigo-100 bg-indigo-50/80 p-4 shadow-sm">
                   <div className="flex items-center justify-between gap-3">
                     <div className="flex min-w-0 items-center gap-3">
                       <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
                         <Calendar size={18} />
                       </div>
                       <div className="min-w-0">
                         <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">Next Appointment</p>
                         <p className="truncate text-sm font-black text-indigo-950">Create New Appointment</p>
                       </div>
                     </div>
                     <button
                       onClick={() => setShowNextAppointmentModal(true)}
                       className="shrink-0 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-black text-white shadow-sm hover:bg-indigo-700"
                     >
                       New
                     </button>
                   </div>
                   {nextAppointmentFeedback && (
                     <div className={`mt-3 rounded-lg border px-3 py-2 text-xs font-semibold flex items-start gap-2 ${
                       nextAppointmentFeedback.type === 'success'
                         ? 'border-green-200 bg-green-50 text-green-700'
                         : 'border-red-200 bg-red-50 text-red-700'
                     }`}>
                       {nextAppointmentFeedback.type === 'success' ? <CheckCircle2 size={14} className="mt-0.5" /> : <AlertCircle size={14} className="mt-0.5" />}
                       <span>{nextAppointmentFeedback.message}</span>
                     </div>
                   )}
                 </div>
               )}

               {loyaltyEnabled && selectedPatient && (
                 <div className="bg-amber-50 p-4 rounded-xl border border-amber-100">
                   <div className="flex justify-between items-center mb-1">
                     <p className="text-[10px] text-amber-600 uppercase font-bold tracking-wider">Loyalty Rewards</p>
                     <Award size={14} className="text-amber-600" />
                   </div>
                   <div className="flex justify-between items-baseline">
                      <p className="text-xl font-black text-amber-700">
                        {selectedPatient.loyalty_points || 0} <span className="text-sm font-bold">Points</span>
                      </p>
                      {onRedeemPoints && canRedeem && (
                        <button
                          onClick={() => {
                            const availablePoints = selectedPatient.loyalty_points || 0;
                            setRedeemPointsInput(Math.min(availablePoints, 1000).toString());
                            setRedeemModal(true);
                          }}
                          className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow-sm flex items-center gap-1"
                        >
                          <Zap size={12} /> Redeem
                        </button>
                      )}
                   </div>
                 </div>
               )}

               <div className={`p-4 rounded-xl border ${selectedPatient.medicalHistory ? 'bg-orange-50 border-orange-100' : 'bg-gray-50 border-gray-100'}`}>
                 <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider mb-1">Medical Alerts</p>
                 <p className={`text-sm ${selectedPatient.medicalHistory ? 'text-orange-900 font-medium' : 'text-gray-500 italic'}`}>
                   {selectedPatient.medicalHistory || "No active medical alerts."}
                 </p>
               </div>

               {onAddMedicines && (
                 <button 
                   className="w-full bg-purple-600 text-white py-3 rounded-xl font-bold text-sm hover:bg-purple-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-purple-600/20"
                   onClick={onAddMedicines}
                 >
                   <Package size={16} /> Add Items
                 </button>
               )}

               <button 
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
                onClick={onGenerateReceipt}
               >
                 <ReceiptIcon size={16} /> Generate Receipt
               </button>
               {onUpdatePatient && selectedPatient && (
                 <button 
                  className="w-full bg-indigo-50 text-indigo-700 py-3 rounded-xl font-bold text-sm mt-2 hover:bg-indigo-100 transition-all flex items-center justify-center gap-2 border border-indigo-100"
                  onClick={() => {
                    setEditModal(true);
                    setEditData({
                      name: selectedPatient.name,
                      email: selectedPatient.email || '',
                      phone: selectedPatient.phone || '',
                      medicalHistory: selectedPatient.medicalHistory || '',
                      location_id: selectedPatient.location_id || ''
                    });
                  }}
                 >
                   <Edit size={16} /> Edit Patient Profile
                 </button>
               )}
               
               {onUpdateAccount && selectedPatient && (
                 <button 
                  className="w-full bg-amber-100 text-amber-700 py-3 rounded-xl font-bold text-sm mt-2 hover:bg-amber-200 transition-all flex items-center justify-center gap-2 border border-amber-200"
                  onClick={() => {
                    setAuthModal(true);
                    setNewPassword('');
                  }}
                 >
                   <User size={16} /> {selectedPatient.has_account ? 'Update Portal Account' : 'Set Portal Account'}
                 </button>
               )}

               {authModal && selectedPatient && (
                 <Modal 
                   title={selectedPatient.has_account ? "Update Portal Account" : "Setup Portal Account"} 
                   onClose={() => setAuthModal(false)}
                 >
                   <div className="space-y-6">
                     <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100 flex items-center gap-4">
                       <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-sm">
                         <User className="text-indigo-600" />
                       </div>
                       <div>
                         <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Patient Name</p>
                         <h4 className="text-lg font-black text-indigo-900">{selectedPatient.name}</h4>
                       </div>
                     </div>

                     <div className="space-y-4">
                       <p className="text-sm text-gray-500 leading-relaxed">
                         {selectedPatient.has_account 
                           ? "Update the password for this patient's portal access. They will use their email, phone, or username to login."
                           : "Create a portal account for this patient. Setting a password will allow them to login and view their history using email, phone, or username."}
                       </p>
                       
                       <Input 
                         label="New Portal Password" 
                         type="password" 
                         placeholder="Enter at least 4 characters"
                         value={newPassword}
                         onChange={(e: any) => setNewPassword(e.target.value)}
                         autoFocus
                       />
                     </div>

                     <div className="flex gap-3 pt-2">
                       <button 
                         onClick={() => setAuthModal(false)}
                         className="flex-1 px-6 py-3 rounded-xl font-bold text-gray-400 hover:bg-gray-50 transition-all border border-transparent"
                       >
                         Cancel
                       </button>
                       <button 
                         disabled={newPassword.length < 4}
                         onClick={async () => {
                           if (onUpdateAccount) {
                             try {
                               await onUpdateAccount(selectedPatient, newPassword);
                               setAuthModal(false);
                             } catch {
                               // The caller reports the error; keep this modal open so it can be corrected.
                             }
                           }
                         }}
                         className="flex-1 bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                       >
                         <Key size={18} />
                         {selectedPatient.has_account ? "Update Password" : "Create Account"}
                       </button>
                     </div>
                   </div>
                 </Modal>
               )}

               {editModal && selectedPatient && (
                 <Modal title="Edit Patient Profile" onClose={() => setEditModal(false)}>
                   <form 
                     onSubmit={async (e) => {
                       e.preventDefault();
                       if (isSubmitting) return;
                        if (!editData.location_id) {
                          alert('Please select a branch/location for this patient.');
                          return;
                        }
                       setIsSubmitting(true);
                       try {
                         if (onUpdatePatient) {
                           await onUpdatePatient(selectedPatient.id, editData);
                           setEditModal(false);
                         }
                       } catch (err: any) {
                         // error handled by onUpdatePatient
                       } finally {
                         setIsSubmitting(false);
                       }
                     }} 
                     className="space-y-5"
                   >
                     <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-2xl border border-gray-100 mb-2">
                       <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-xl">
                         {selectedPatient.name.charAt(0)}
                       </div>
                       <div>
                         <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Editing Patient</p>
                         <h4 className="text-lg font-black text-gray-900">{selectedPatient.name}</h4>
                       </div>
                     </div>

                     <Input label="Full Patient Name" required value={editData.name} onChange={(e: any) => setEditData({...editData, name: e.target.value})} />
                      <div>
                        <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 ml-1">Branch / Location</label>
                        <select
                          required
                          className="w-full border-gray-200 border rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all bg-white"
                          value={editData.location_id}
                          onChange={(e) => setEditData({...editData, location_id: e.target.value})}
                        >
                          <option value="">Select a branch...</option>
                          {locations.map((loc) => (
                            <option key={loc.id} value={loc.id}>{loc.name}</option>
                          ))}
                        </select>
                        {selectedPatient.location_id !== editData.location_id && editData.location_id && (
                          <p className="mt-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                            Saving will transfer this patient profile and portal access to the selected branch.
                          </p>
                        )}
                      </div>
                     <div className="grid grid-cols-2 gap-4">
                        <Input label="Primary Email" type="email" value={editData.email} onChange={(e: any) => setEditData({...editData, email: e.target.value})} />
                        <Input label="Mobile Contact" required value={editData.phone} onChange={(e: any) => setEditData({...editData, phone: e.target.value})} />
                     </div>
                     
                     <div>
                       <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 ml-1">Relevant Medical History</label>
                       <textarea className="w-full border-gray-200 border rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all" rows={4}
                         value={editData.medicalHistory} onChange={e => setEditData({...editData, medicalHistory: e.target.value})} />
                     </div>
                     <button 
                       type="submit" 
                       disabled={isSubmitting}
                       className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-700 transition-all mt-2"
                     >
                       {isSubmitting ? 'Saving Changes...' : 'Save Changes'}
                     </button>
                   </form>
                 </Modal>
               )}

               {selectedTreatmentForCharge && selectedPatient && (
                 <Modal title="Confirm Treatment Charge" onClose={handleChargeModalClose}>
                   <div className="space-y-5">
                     <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
                       <p className="text-[10px] font-black uppercase tracking-widest text-indigo-500">Treatment</p>
                       <h4 className="mt-1 text-lg font-black text-indigo-950">{selectedTreatmentForCharge.name}</h4>
                       <p className="mt-1 text-sm font-semibold text-indigo-700">
                         {useFlatRate
                           ? 'Flat-rate treatment'
                           : `${selectedTeeth.length} tooth${selectedTeeth.length === 1 ? '' : ' teeth'} selected`}
                       </p>
                     </div>

                     <div className="grid grid-cols-2 gap-3">
                       <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                         <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Standard Charge</p>
                         <p className="mt-1 text-xl font-black text-gray-900">
                           {formatCurrency(selectedTreatmentStandardTotal, currency)}
                         </p>
                       </div>
                       <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                         <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Final Charge</p>
                         <p className="mt-1 text-xl font-black text-gray-900">
                           {formatCurrency(selectedTreatmentFinalTotal, currency)}
                         </p>
                         {selectedTreatmentTotalDiscount > 0 && (
                           <div className="mt-1 space-y-0.5 text-xs font-bold text-amber-700">
                             <p>Total discount: -{formatCurrency(selectedTreatmentTotalDiscount, currency)}</p>
                             {overallTreatmentDiscount > 0 && individualTreatmentDiscount > 0 ? (
                               <p className="font-semibold text-amber-600">
                                 Includes overall: -{formatCurrency(overallTreatmentDiscount, currency)}
                               </p>
                             ) : null}
                           </div>
                         )}
                       </div>
                     </div>

                     <div className="space-y-3">
                       {getTreatmentChargeLines(selectedTreatmentForCharge).map((line, index) => {
                         const currentInput = treatmentChargeInputs[index] ?? String(line.cost);
                         const currentCost = Number.parseFloat(currentInput);
                         const finalCost = Number.isFinite(currentCost) ? Math.max(0, currentCost) : 0;
                         const adjustment = Math.max(0, line.standardCost - finalCost);
                         const lineLabel = line.teeth.length > 0
                           ? `Tooth ${formatTeethArray(line.teeth)}`
                           : 'Flat-rate treatment';

                         return (
                           <div key={`${lineLabel}-${index}`} className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                             <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                               <div>
                                 <p className="text-sm font-black text-gray-900">{lineLabel}</p>
                                 <p className="text-xs font-semibold text-gray-500">
                                   Standard: {formatCurrency(line.standardCost, currency)}
                                 </p>
                               </div>
                               {adjustment > 0 && (
                                 <span className={`rounded-full px-3 py-1 text-xs font-black ${finalCost === 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                   {finalCost === 0 ? 'FOC' : 'Discount'} -{formatCurrency(adjustment, currency)}
                                 </span>
                               )}
                             </div>
                             <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                               <Input
                                 label={`Final Charge (${currencySymbol})`}
                                 type="number"
                                 min="0"
                                 step="0.01"
                                 value={currentInput}
                                 onChange={(e: any) => {
                                   const nextInputs = [...treatmentChargeInputs];
                                   nextInputs[index] = e.target.value;
                                   setTreatmentChargeInputs(nextInputs);
                                 }}
                                 autoFocus={index === 0}
                               />
                               <button
                                 type="button"
                                 onClick={() => {
                                   const nextInputs = [...treatmentChargeInputs];
                                   nextInputs[index] = String(line.standardCost);
                                   setTreatmentChargeInputs(nextInputs);
                                 }}
                                 className="rounded-xl border border-gray-200 px-3 py-3 text-xs font-black text-gray-700 hover:bg-gray-50"
                               >
                                 Standard
                               </button>
                               <button
                                 type="button"
                                 onClick={() => {
                                   const nextInputs = [...treatmentChargeInputs];
                                   nextInputs[index] = '0';
                                   setTreatmentChargeInputs(nextInputs);
                                 }}
                                 className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs font-black text-amber-700 hover:bg-amber-100"
                               >
                                 FOC
                               </button>
                             </div>
                           </div>
                         );
                       })}
                     </div>

                     <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                       <div className="mb-3">
                         <p className="text-sm font-black text-amber-950">Overall Discount</p>
                         <p className="mt-1 text-xs font-semibold text-amber-800">
                           Applied after the individual treatment charges below.
                         </p>
                       </div>
                       <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                         <Input
                           label={`Overall Discount (${currencySymbol})`}
                           type="number"
                           inputMode="decimal"
                           min="0"
                           max={selectedTreatmentLineSubtotal}
                           step="0.01"
                           value={overallTreatmentDiscountInput}
                           onChange={(event: any) => setOverallTreatmentDiscountInput(event.target.value)}
                           onBlur={() => setOverallTreatmentDiscountInput(String(overallTreatmentDiscount))}
                         />
                         <button
                           type="button"
                           onClick={() => setOverallTreatmentDiscountInput('0')}
                           disabled={overallTreatmentDiscount === 0}
                           className="min-h-11 rounded-xl border border-amber-200 bg-white px-4 py-3 text-xs font-black text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                         >
                           Clear Discount
                         </button>
                       </div>
                       <div className="mt-3 flex items-center justify-between gap-3 border-t border-amber-200 pt-3 text-sm">
                         <span className="font-semibold text-amber-800">Charge before overall discount</span>
                         <span className="font-black text-amber-950">{formatCurrency(selectedTreatmentLineSubtotal, currency)}</span>
                       </div>
                     </div>

                     <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                       <button
                         type="button"
                         onClick={() => {
                           setTreatmentChargeInputs(getTreatmentChargeLines(selectedTreatmentForCharge).map((line) => String(line.standardCost)));
                           setOverallTreatmentDiscountInput('0');
                         }}
                         className="rounded-xl border border-gray-200 px-3 py-2.5 text-xs font-black text-gray-700 hover:bg-gray-50"
                       >
                         All Standard
                       </button>
                       <button
                         type="button"
                         onClick={() => {
                           setTreatmentChargeInputs(getTreatmentChargeLines(selectedTreatmentForCharge).map(() => '0'));
                           setOverallTreatmentDiscountInput('0');
                         }}
                         className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-black text-amber-700 hover:bg-amber-100"
                       >
                         All FOC
                       </button>
                     </div>

                     <div className="flex gap-3 pt-1">
                       <button
                         type="button"
                         onClick={handleChargeModalClose}
                         disabled={isRecordingTreatment}
                         className="flex-1 rounded-xl border border-gray-200 px-6 py-3 font-bold text-gray-500 hover:bg-gray-50"
                       >
                         Cancel
                       </button>
                       <button
                         type="button"
                         onClick={handleConfirmTreatmentCharge}
                         disabled={isRecordingTreatment}
                         className="flex-1 rounded-xl bg-indigo-600 px-6 py-3 font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
                       >
                         {isRecordingTreatment ? 'Please Wait...' : 'Record Treatment'}
                       </button>
                     </div>
                   </div>
                 </Modal>
               )}

               {isRecordingTreatment && (
                 <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 backdrop-blur-sm px-4">
                   <div className="w-full max-w-sm rounded-[2rem] border border-white/70 bg-white/95 p-7 text-center shadow-2xl shadow-slate-900/20 animate-fade-in">
                     <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                       <Loader2 className="h-8 w-8 animate-spin" />
                     </div>
                     <h3 className="mt-5 text-2xl font-black text-slate-900">Please wait</h3>
                     <p className="mt-2 text-sm font-medium leading-6 text-slate-500">
                       Recording treatment and updating the patient's clinical history.
                     </p>
                     <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100">
                       <div className="h-full w-1/2 animate-pulse rounded-full bg-emerald-500" />
                     </div>
                   </div>
                 </div>
               )}

               {redeemModal && selectedPatient && (
                 <Modal
                   title="Redeem Loyalty Points"
                   onClose={() => {
                     setRedeemModal(false);
                     setRedeemPointsInput('');
                   }}
                 >
                   <div className="space-y-5">
                     <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100">
                       <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Patient</p>
                       <p className="text-lg font-black text-amber-900">{selectedPatient.name}</p>
                       <p className="text-sm text-amber-700 mt-1">Available Points: <span className="font-bold">{selectedPatient.loyalty_points || 0}</span></p>
                     </div>

                     <Input
                       label="Points to Redeem"
                       type="number"
                       min={1}
                       max={selectedPatient.loyalty_points || 0}
                       value={redeemPointsInput}
                       onChange={(e: any) => setRedeemPointsInput(e.target.value)}
                       autoFocus
                     />

                     <div className="flex gap-3">
                       <button
                         onClick={() => {
                           setRedeemModal(false);
                           setRedeemPointsInput('');
                         }}
                         className="flex-1 px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-50 transition-all"
                       >
                         Cancel
                       </button>
                       <button
                         onClick={handleRedeemSubmit}
                         className="flex-1 bg-amber-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-amber-600/20 hover:bg-amber-700 transition-all"
                       >
                         Redeem
                       </button>
                     </div>
                   </div>
                 </Modal>
               )}

               {deleteModal && fileToDelete && (
                 <Modal
                   title="Delete Patient Document"
                   onClose={() => {
                     setDeleteModal(false);
                     setFileToDelete(null);
                   }}
                 >
                   <div className="space-y-5">
                     <div className="p-4 bg-red-50 rounded-2xl border border-red-100 flex items-start gap-4">
                       <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                         <Trash2 className="text-red-600" size={24} />
                       </div>
                       <div className="flex-1">
                         <p className="text-sm font-semibold text-red-900 mb-1">Warning: This action cannot be undone</p>
                         <p className="text-sm text-red-700">You are about to permanently delete:</p>
                         <p className="text-base font-bold text-red-900 mt-2 p-2 bg-white rounded-lg border border-red-200">
                           {fileToDelete.name}
                         </p>
                       </div>
                     </div>

                     <div className="flex gap-3">
                       <button
                         onClick={() => {
                           setDeleteModal(false);
                           setFileToDelete(null);
                         }}
                         className="flex-1 px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-50 transition-all border border-gray-200"
                       >
                         Cancel
                       </button>
                       <button
                         onClick={() => {
                           if (fileToDelete) {
                             onDeleteFile(fileToDelete.path);
                             setDeleteModal(false);
                             setFileToDelete(null);
                             setOpenMenuId(null);
                           }
                         }}
                         className="flex-1 bg-red-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-red-600/20 hover:bg-red-700 transition-all flex items-center justify-center gap-2"
                       >
                         <Trash2 size={18} />
                         Delete Permanently
                       </button>
                     </div>
                   </div>
                 </Modal>
               )}

               <button 
                className="w-full bg-gray-900 text-white py-3 rounded-xl font-bold text-sm mt-2 hover:bg-gray-800 transition-all flex items-center justify-center gap-2"
                onClick={onClosePatient}
               >
                 <X size={16} /> Close Patient File
               </button>
             </div>

             {/* Loyalty History */}
             {loyaltyEnabled && loyaltyTransactions.length > 0 && (
               <div className="mt-6">
                 <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Recent Points Activity</h4>
                 <div className="space-y-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                   {loyaltyTransactions.slice(0, 5).map(tx => (
                     <div key={tx.id} className="flex justify-between items-center p-2 rounded-lg bg-gray-50 border border-gray-100">
                       <div>
                         <p className="text-[11px] font-bold text-gray-800">{tx.description}</p>
                         <p className="text-[9px] text-gray-400">{new Date(tx.date).toLocaleDateString()}</p>
                       </div>
                       <span className={`text-xs font-black ${tx.points > 0 ? 'text-green-600' : 'text-red-600'}`}>
                         {tx.points > 0 ? '+' : ''}{tx.points}
                       </span>
                     </div>
                   ))}
                 </div>
               </div>
             )}
          </div>
        ) : (
          <div className="text-center py-12 px-4 border-2 border-dashed border-gray-100 rounded-2xl">
            <User className="w-10 h-10 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500 mb-5 font-medium">No patient currently active in focus.</p>
            <button 
              onClick={onOpenDirectory}
              className="bg-indigo-50 text-indigo-700 font-bold px-6 py-2 rounded-xl text-xs hover:bg-indigo-100"
            >
              Open Directory
            </button>
          </div>
        )}
      </div>

      {selectedPatient && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider mb-1">Files & Imaging</p>
              <h3 className="text-lg font-bold text-gray-800">Patient Documents</h3>
            </div>
            {patientFiles.length > 0 && (
              <span className="px-3 py-1 bg-indigo-100 text-indigo-700 text-xs font-bold rounded-full">
                {patientFiles.length} file{patientFiles.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-4 text-center bg-gray-50 transition-colors ${
              isUploadingWithProgress ? 'border-indigo-400 bg-indigo-50/50' : 'border-gray-200 hover:border-indigo-300'
            }`}
          >
            <Upload className="w-8 h-8 text-indigo-500 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-800">Drag & drop X-rays, documents, videos, or ZIP files</p>
            <p className="text-xs text-gray-500 mb-3">Accepted: images, PDF, videos, ZIP. Smart chunked upload enabled.</p>

            {/* Upload Progress Bar */}
            {isUploadingWithProgress && uploadProgress && (
              <div className="mb-3 mx-auto max-w-md">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-600 truncate max-w-[200px] font-medium">{uploadProgress.fileName}</span>
                  <span className="font-bold text-indigo-600">{uploadProgress.percentage}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-indigo-500 to-purple-600 h-2.5 rounded-full transition-all duration-300 relative"
                    style={{ width: `${uploadProgress.percentage}%` }}
                  >
                    <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
                  </div>
                </div>
                <div className="flex justify-between items-center mt-1.5">
                  <p className="text-xs text-gray-500">
                    {formatBytes(uploadProgress.bytesUploaded)} / {formatBytes(uploadProgress.bytesTotal)}
                  </p>
                  <p className="text-xs text-indigo-600 font-semibold flex items-center gap-1">
                    <span className="inline-block w-2 h-2 bg-indigo-600 rounded-full animate-pulse"></span>
                    Smart chunked upload
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-center gap-3">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingWithProgress}
                className="px-3 py-1.5 text-xs font-bold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Browse files
              </button>
              {(uploadingFiles || isUploadingWithProgress) && (
                <span className="text-xs text-[var(--hover-600)] font-semibold flex items-center gap-1">
                  <span className="animate-spin inline-block w-3 h-3 border-2 border-[var(--hover-600)] border-t-transparent rounded-full" />
                  Uploading...
                </span>
              )}
            </div>
            <input
              type="file"
              multiple
              accept="image/*,application/pdf,video/*,.zip,application/zip,application/x-zip-compressed"
              ref={fileInputRef}
              onChange={handleBrowse}
              disabled={isUploadingWithProgress}
              className="hidden"
            />
          </div>

          <div className="mt-5">
            <div className="space-y-2">
              {patientFiles.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-500 font-medium">No files uploaded for this patient</p>
                  <p className="text-xs text-gray-400 mt-1">Upload documents using the area above</p>
                </div>
              ) : (
                <>
                  {paginatedFiles.map((file) => (
                    <div key={file.path} className="group relative border border-gray-100 rounded-xl p-4 hover:border-indigo-200 hover:bg-gradient-to-r hover:from-indigo-50/50 hover:to-purple-50/30 transition-all duration-200">
                      <div className="flex items-start gap-3">
                        {/* File Icon */}
                        <div className="flex-shrink-0 w-10 h-10 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-lg flex items-center justify-center">
                          <FileText className="w-5 h-5 text-indigo-600" />
                        </div>

                        {/* File Info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-gray-800 truncate mb-0.5">{file.name}</p>
                          <p className="text-xs text-gray-500">
                            {file.type?.split('/')[1]?.toUpperCase() || 'File'} · {formatBytes(file.size)}
                          </p>
                        </div>

                        {/* Three-Dot Menu Button */}
                        <div className="flex-shrink-0">
                          <button
                            ref={(el) => { buttonRefs.current[file.path] = el }}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleMenu(file.path, e);
                            }}
                            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-all duration-200"
                            title="More options"
                          >
                            <MoreVertical size={18} />
                          </button>

                          {/* Dropdown Menu */}
                          {openMenuId === file.path && menuPosition && (
                            <div
                              ref={menuRef}
                              className="fixed w-48 bg-white rounded-xl shadow-xl border border-gray-100 py-2 z-[9999] animate-in fade-in slide-in-from-top-2 duration-200"
                              style={{
                                top: `${menuPosition.top}px`,
                                right: `${menuPosition.right}px`
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                            >
                              {/* View Option */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(file.url, '_blank');
                                  setOpenMenuId(null);
                                }}
                                className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 transition-colors w-full text-left"
                              >
                                <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
                                  <Eye size={16} className="text-indigo-600" />
                                </div>
                                <div>
                                  <p className="font-medium">View</p>
                                  <p className="text-xs text-gray-500">Open in new tab</p>
                                </div>
                              </button>

                              {/* Download Option */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const link = document.createElement('a');
                                  link.href = file.url;
                                  link.download = file.name;
                                  link.target = '_blank';
                                  document.body.appendChild(link);
                                  link.click();
                                  document.body.removeChild(link);
                                  setOpenMenuId(null);
                                }}
                                className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-green-50 hover:text-green-700 transition-colors w-full text-left"
                              >
                                <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
                                  <Download size={16} className="text-green-600" />
                                </div>
                                <div>
                                  <p className="font-medium">Download</p>
                                  <p className="text-xs text-gray-500">Save to device</p>
                                </div>
                              </button>

                              {/* Divider */}
                              <div className="my-2 border-t border-gray-100"></div>

                              {/* Delete Option */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFileToDelete({ name: file.name, path: file.path });
                                  setDeleteModal(true);
                                }}
                                className="flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 w-full transition-colors"
                              >
                                <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                                  <Trash2 size={16} className="text-red-600" />
                                </div>
                                <div className="text-left">
                                  <p className="font-medium">Remove</p>
                                  <p className="text-xs text-gray-500">Delete permanently</p>
                                </div>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-4">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`w-8 h-8 rounded-lg text-sm font-bold transition-all ${
                      currentPage === page
                        ? 'bg-indigo-600 text-white shadow-md'
                        : 'bg-gray-100 text-gray-600 hover:bg-indigo-100 hover:text-indigo-700'
                    }`}
                  >
                    {page}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showPatientReport && selectedPatient && (
        <React.Suspense fallback={
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-900/60 backdrop-blur-md">
            <div className="rounded-2xl bg-white px-6 py-5 text-center shadow-2xl"><Loader2 className="mx-auto animate-spin text-indigo-600" /><p className="mt-2 text-sm font-bold text-gray-700">Preparing patient report…</p></div>
          </div>
        }>
          <AboutPatientReport
            patient={selectedPatient}
            appointments={appointments}
            treatments={treatmentHistory}
            medicineSales={medicineSales}
            payments={paymentRecords}
            paymentsAvailable={paymentsAvailable}
            doctors={doctors}
            currency={currency}
            onClose={() => setShowPatientReport(false)}
          />
        </React.Suspense>
      )}

      {showNextAppointmentModal && selectedPatient && onCreateAppointment && (
        <Modal
          title="Schedule Next Appointment"
          onClose={() => setShowNextAppointmentModal(false)}
        >
          <form onSubmit={handleCreateNextAppointment} className="space-y-4">
            <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
              <p className="text-[10px] text-indigo-600 uppercase font-bold tracking-wider">Patient</p>
              <p className="text-sm font-bold text-indigo-900">{selectedPatient.name}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => handleQuickDateApply({ unit: 'weeks', amount: 1 })} className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-[11px] font-bold text-indigo-700 hover:bg-indigo-100">+1 Week</button>
              <button type="button" onClick={() => handleQuickDateApply({ unit: 'weeks', amount: 2 })} className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-[11px] font-bold text-indigo-700 hover:bg-indigo-100">+2 Weeks</button>
              <button type="button" onClick={() => handleQuickDateApply({ unit: 'months', amount: 1 })} className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-[11px] font-bold text-indigo-700 hover:bg-indigo-100">+1 Month</button>
              <button type="button" onClick={() => handleQuickDateApply({ unit: 'months', amount: 6 })} className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-[11px] font-bold text-indigo-700 hover:bg-indigo-100">+6 Months</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Date"
                type="date"
                required
                value={nextAppointmentForm.date || ''}
                onChange={(e: any) => setNextAppointmentForm((prev) => ({ ...prev, date: e.target.value }))}
              />
              <TimeInput
                label="Time"
                required
                value={nextAppointmentForm.time || ''}
                onChange={(time) => setNextAppointmentForm((prev) => ({ ...prev, time }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1.5">Doctor (Optional)</label>
                <SearchableSelect
                  value={nextAppointmentForm.doctor_id || ''}
                  onChange={(doctorId) => setNextAppointmentForm((prev) => ({ ...prev, doctor_id: doctorId }))}
                  options={[
                    { value: '', label: 'No specific doctor' },
                    ...doctors.map((doctor) => ({
                      value: doctor.id,
                      label: `${formatDoctorName(doctor.name)}${doctor.specialization ? ` - ${doctor.specialization}` : ''}`
                    }))
                  ]}
                  placeholder="Select doctor"
                  emptyMessage="No doctors found"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1.5">Type</label>
                <SearchableSelect
                  value={nextAppointmentForm.type || ''}
                  onChange={(selectedType) => setNextAppointmentForm((prev) => ({ ...prev, type: selectedType }))}
                  options={appointmentTypeOptionsForAppointment.map((typeName) => ({ value: typeName, label: typeName }))}
                  placeholder="Select appointment type"
                  emptyMessage="No appointment type found"
                />
                {appointmentTypeOptions.length === 0 && (
                  <p className="text-xs text-amber-600 mt-1">No appointment types configured yet. Add appointment types in Settings first.</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-gray-500 uppercase font-bold tracking-wider mb-1.5">Notes</label>
              <textarea
                rows={3}
                value={nextAppointmentForm.notes || ''}
                onChange={(e) => setNextAppointmentForm((prev) => ({ ...prev, notes: e.target.value }))}
                className="w-full border-gray-200 border rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all resize-none"
                placeholder="Optional notes for front desk or doctor..."
              />
            </div>

            {nextAppointmentFeedback?.type === 'error' && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5" />
                <span>{nextAppointmentFeedback.message}</span>
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setShowNextAppointmentModal(false)}
                className="flex-1 rounded-xl border border-gray-200 px-4 py-3 text-sm font-bold text-gray-600 hover:bg-gray-50 transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSavingNextAppointment}
                className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
              >
                {isSavingNextAppointment ? 'Scheduling...' : 'Create Appointment'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  </div>
  );
};

export default ClinicalView;


