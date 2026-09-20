import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Search, Plus, Loader2, ChevronRight, Award, User, ShieldCheck, ShieldAlert, Key, Edit, MoreVertical, ArrowLeft, Calendar, Clock, Filter, AlertTriangle, RotateCw } from 'lucide-react';
import { Patient, LoyaltyRule, Appointment, ClinicalRecord, PatientType, TreatmentType, Doctor, Location } from '../types';
import { formatCurrency, Currency } from '../utils/currency';
import { exportPatientsToPDF } from '../utils/pdfExport';
import { exportPatientsToExcel } from '../utils/excelExport';
import Pagination from './Pagination';
import { Modal, Input, ConfirmDialog } from './Shared';
import ExportMenu from './ExportMenu';
import { SearchableSelect } from './SearchableSelect';
import { getMyanmarCities, getTownshipsForCity } from '../utils/myanmarCities';
import { api } from '../services/api';
import { DEFAULT_PATIENT_TYPE_NAME, DEFAULT_PATIENT_TYPE_OPTIONS } from '../constants';
import PatientQRScanButton from './PatientQRScanButton';
import { formatDoctorName, normalizeDoctorName } from '../utils/doctorName';

type BranchTransferRecordState = {
  hasAppointments: boolean;
  hasTreatments: boolean;
  hasLoyalty: boolean;
  hasAny: boolean;
};

interface PatientsViewProps {
  patients: Patient[];
  patientTypes: PatientType[];
  locations: Location[];
  appointments: Appointment[];
  loading: boolean;
  currency: Currency;
  onSelectPatient: (patient: Patient) => void;
  onAddPatient: () => void;
  onUpdatePatient?: (id: string, data: Partial<Patient>) => Promise<void>;
  onDeletePatient?: (id: string) => Promise<void>;
  onRedeemPoints?: (patient: Patient, points: number, amount: number) => void;
  onUpdatePatientAuth?: (patient: Patient, password: string) => Promise<void>;
  onNotify?: (message: string, type: 'success' | 'error' | 'info') => void;
  onExportPDF?: () => Promise<void>;
  onExportExcel?: () => Promise<void>;
  onRefresh?: () => void | Promise<void>;
  patientToEdit?: Patient | null;
  onPatientEditHandled?: () => void;
  loyaltyEnabled: boolean;
  loyaltyRules?: LoyaltyRule[];
  doctors?: Pick<Doctor, 'id' | 'name'>[];
  treatmentTypes?: TreatmentType[];
  treatmentRecords?: ClinicalRecord[];
}

const PatientsView: React.FC<PatientsViewProps> = ({ 
  patients, 
  patientTypes,
  locations,
  appointments,
  loading, 
  currency, 
  onSelectPatient, 
  onAddPatient, 
  onUpdatePatient,
  onDeletePatient,
  onRedeemPoints, 
  onUpdatePatientAuth,
  onNotify,
  onExportPDF,
  onExportExcel,
  onRefresh,
  patientToEdit,
  onPatientEditHandled,
  loyaltyEnabled, 
  loyaltyRules = [],
  doctors = [],
  treatmentTypes = [],
  treatmentRecords = []
}) => {
  const notify = (message: string, type: 'success' | 'error' | 'info') => {
    if (onNotify) {
      onNotify(message, type);
      return;
    }
    alert(message);
  };
  const [currentPage, setCurrentPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [dateQuickFilter, setDateQuickFilter] = useState<'all' | 'today' | 'custom' | 'new'>('all');
  const [dateFilter, setDateFilter] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');
  const [visitDateQuickFilter, setVisitDateQuickFilter] = useState<'all' | 'today' | 'week' | 'month' | 'custom'>('all');
  const [visitDateFilter, setVisitDateFilter] = useState('');
  const [visitEndDateFilter, setVisitEndDateFilter] = useState('');
  const [doctorFilter, setDoctorFilter] = useState('');
  const [treatmentFilter, setTreatmentFilter] = useState('');
  const [authModal, setAuthModal] = useState<{ open: boolean, patient: Patient | null }>({ open: false, patient: null });
  const [editModal, setEditModal] = useState<{ open: boolean, patient: Patient | null }>({ open: false, patient: null });
  const [redeemModal, setRedeemModal] = useState<{ open: boolean, patient: Patient | null }>({ open: false, patient: null });
  const [redeemPointsInput, setRedeemPointsInput] = useState('');
  const [editData, setEditData] = useState({ 
    name: '', 
    email: '', 
    phone: '', 
    medicalHistory: '',
    age: '',
    address: '',
    city: '',
    township: '',
    patient_type: DEFAULT_PATIENT_TYPE_NAME,
    location_id: ''
  });
  const [newPassword, setNewPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [detailPatient, setDetailPatient] = useState<Patient | null>(null);
  const [showFullPatientId, setShowFullPatientId] = useState(false);
  const [openActionMenuPatientId, setOpenActionMenuPatientId] = useState<string | null>(null);
  const [treatmentRecordsByPatientId, setTreatmentRecordsByPatientId] = useState<Record<string, ClinicalRecord[]>>({});
  const [treatmentRecordsLoadingForPatientId, setTreatmentRecordsLoadingForPatientId] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const deletePatientIdRef = useRef<string | null>(null);
  const deletePatientNameRef = useRef<string>('this patient');
  const itemsPerPage = 100;
  const [branchTransferBlockedOpen, setBranchTransferBlockedOpen] = useState(false);
  const [branchTransferBlockedRecords, setBranchTransferBlockedRecords] = useState<string[]>([]);

  const isBranchTransferValidationError = (error: unknown) =>
    error instanceof Error && error.message.includes('Cannot transfer branch: Patient has existing records');

  const openEditPatientModal = (patient: Patient) => {
    setEditModal({ open: true, patient });
    setEditData({
      name: patient.name,
      email: patient.email || '',
      phone: patient.phone || '',
      medicalHistory: patient.medicalHistory || '',
      age: patient.age?.toString() || '',
      address: patient.address || '',
      city: patient.city || '',
      township: patient.township || '',
      patient_type: normalizePatientType(patient.patient_type),
      location_id: patient.location_id || ''
    });
  };

  useEffect(() => {
    if (!patientToEdit) return;

    openEditPatientModal(patientToEdit);
    onPatientEditHandled?.();
  }, [patientToEdit, onPatientEditHandled]);

  const getBranchTransferBlockedItems = (recordState: BranchTransferRecordState): string[] => {
    const blockedItems: string[] = [];
    if (recordState.hasAppointments) blockedItems.push('Appointments');
    if (recordState.hasTreatments) blockedItems.push('Treatment Records');
    if (recordState.hasLoyalty) blockedItems.push('Loyalty Transactions');
    return blockedItems;
  };

  const toLocalISODate = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const todayISO = useMemo(() => toLocalISODate(new Date()), []);

  const todayVisitStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const weekAgoStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  }, []);
  const monthAgoStr = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  }, []);

  const isNewPatientToday = (patient: Patient) => {
    if (!patient.created_at) return false;
    const createdAt = new Date(patient.created_at);
    if (Number.isNaN(createdAt.getTime())) return false;
    return toLocalISODate(createdAt) === todayISO;
  };

  const formatCreatedDate = (createdAt?: string) => {
    if (!createdAt) return 'N/A';

    const isoDateMatch = createdAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year.slice(-2)}`;
    }

    const parsedDate = new Date(createdAt);
    if (Number.isNaN(parsedDate.getTime())) return 'N/A';

    const day = String(parsedDate.getDate()).padStart(2, '0');
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const year = String(parsedDate.getFullYear()).slice(-2);
    return `${day}/${month}/${year}`;
  };

  const formatAppointmentDate = (dateString?: string) => {
    if (!dateString) return '-';

    const isoDateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateMatch) {
      const [, year, month, day] = isoDateMatch;
      return `${day}/${month}/${year}`;
    }

    const parsedDate = new Date(dateString);
    if (Number.isNaN(parsedDate.getTime())) return '-';

    const day = String(parsedDate.getDate()).padStart(2, '0');
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const year = parsedDate.getFullYear();
    return `${day}/${month}/${year}`;
  };

  const nextAppointmentByPatientId = useMemo(() => {
    const map = new Map<string, Appointment>();
    const now = new Date();

    appointments.forEach((appointment) => {
      const patientId = (appointment.patient_id || '').trim();
      if (!patientId || appointment.status !== 'Scheduled' || !appointment.date) {
        return;
      }

      const appointmentDateTime = new Date(`${appointment.date}T${appointment.time || '00:00'}`);
      if (Number.isNaN(appointmentDateTime.getTime()) || appointmentDateTime < now) {
        return;
      }

      const currentNearest = map.get(patientId);
      if (!currentNearest) {
        map.set(patientId, appointment);
        return;
      }

      const currentNearestDateTime = new Date(`${currentNearest.date}T${currentNearest.time || '00:00'}`);
      if (appointmentDateTime < currentNearestDateTime) {
        map.set(patientId, appointment);
      }
    });

    return map;
  }, [appointments]);

  // Build a map of patient_id -> treatment records for quick lookup
  const treatmentRecordsByPatientIdMap = useMemo(() => {
    const map = new Map<string, ClinicalRecord[]>();
    treatmentRecords.forEach((record) => {
      if (!map.has(record.patient_id)) {
        map.set(record.patient_id, []);
      }
      map.get(record.patient_id)!.push(record);
    });
    return map;
  }, [treatmentRecords]);

  // Compute last visit date per patient from appointments
  const patientLastVisitMap = useMemo(() => {
    const map = new Map<string, string>();
    appointments.forEach((apt) => {
      if (!apt.patient_id || !apt.date) return;
      const existing = map.get(apt.patient_id);
      if (!existing || apt.date > existing) {
        map.set(apt.patient_id, apt.date);
      }
    });
    return map;
  }, [appointments]);

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const makeUniqueSortedOptions = (values: string[]) => {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
  };

  const getUniquePatientDoctorNames = (records: ClinicalRecord[]) => (
    [...new Set(records.map((record) => normalizeDoctorName(record.doctor_name)).filter(Boolean))]
  );

  const doctorNameById = useMemo(() => {
    const map = new Map<string, string>();
    doctors.forEach((doctor) => {
      if (doctor.id && doctor.name?.trim()) {
        map.set(doctor.id, doctor.name.trim());
      }
    });
    return map;
  }, [doctors]);

  // Doctor filter options are linked to the configured Doctors list.
  // Historical record-only doctors are appended so old records remain filterable.
  const doctorOptions = useMemo(() => {
    const configuredOptions = doctors
      .filter((doctor) => doctor.id && doctor.name?.trim())
      .map((doctor) => ({ value: `id:${doctor.id}`, label: doctor.name.trim() }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const configuredDoctorNames = new Set(configuredOptions.map((option) => option.label.toLowerCase()));
    const historicalOptions = makeUniqueSortedOptions(
      treatmentRecords.map((record) => record.doctor_name || '')
    )
      .filter((name) => !configuredDoctorNames.has(name.toLowerCase()))
      .map((name) => ({ value: `name:${name}`, label: name }));

    return [...configuredOptions, ...historicalOptions];
  }, [doctors, treatmentRecords]);

  // Treatment filter options are linked to configured Treatment Types.
  // Historical record-only descriptions are appended so old records remain filterable.
  const treatmentOptions = useMemo(() => {
    const configuredNames = makeUniqueSortedOptions(treatmentTypes.map((treatmentType) => treatmentType.name || ''));
    const configuredNameSet = new Set(configuredNames.map((name) => name.toLowerCase()));
    const historicalNames = makeUniqueSortedOptions(treatmentRecords.map((record) => record.description || ''))
      .filter((name) => !configuredNameSet.has(name.toLowerCase()));

    return [...configuredNames, ...historicalNames];
  }, [treatmentTypes, treatmentRecords]);

  // Filtered data based on selected scope and search term
  const filteredPatients = useMemo(() => {
    let scopedPatients = patients;

    // Apply date quick filter
    if (dateQuickFilter === 'new') {
      scopedPatients = scopedPatients.filter((patient) => isNewPatientToday(patient));
    } else if (dateQuickFilter === 'custom' && (dateFilter || endDateFilter)) {
      const rangeStart = dateFilter && endDateFilter && dateFilter > endDateFilter ? endDateFilter : dateFilter;
      const rangeEnd = dateFilter && endDateFilter && dateFilter > endDateFilter ? dateFilter : endDateFilter;
      scopedPatients = scopedPatients.filter((patient) => {
        if (!patient.created_at) return false;
        const dateStr = patient.created_at.substring(0, 10);
        if (rangeStart && dateStr < rangeStart) return false;
        if (rangeEnd && dateStr > rangeEnd) return false;
        return true;
      });
    }

    // Apply visit date filter
    if (visitDateQuickFilter !== 'all' || visitDateFilter || visitEndDateFilter) {
      const visitRangeStart = visitDateQuickFilter === 'today' ? todayVisitStr
        : visitDateQuickFilter === 'week' ? weekAgoStr
        : visitDateQuickFilter === 'month' ? monthAgoStr
        : (visitDateFilter && visitEndDateFilter && visitDateFilter > visitEndDateFilter ? visitEndDateFilter : visitDateFilter);
      const visitRangeEnd = visitDateQuickFilter === 'today' ? todayVisitStr
        : visitDateQuickFilter === 'week' ? todayVisitStr
        : visitDateQuickFilter === 'month' ? todayVisitStr
        : (visitDateFilter && visitEndDateFilter && visitDateFilter > visitEndDateFilter ? visitDateFilter : visitEndDateFilter);

      scopedPatients = scopedPatients.filter((patient) => {
        const lastVisit = patientLastVisitMap.get(patient.id);
        if (!lastVisit) return false;
        if (visitRangeStart && lastVisit < visitRangeStart) return false;
        if (visitRangeEnd && lastVisit > visitRangeEnd) return false;
        return true;
      });
    }

    // Apply doctor filter
    if (doctorFilter) {
      const patientIdsWithDoctor = new Set<string>();
      const isDoctorIdFilter = doctorFilter.startsWith('id:');
      const doctorFilterValue = doctorFilter.replace(/^(id|name):/, '');
      const selectedDoctorName = isDoctorIdFilter ? doctorNameById.get(doctorFilterValue) : doctorFilterValue;
      treatmentRecords.forEach((record) => {
        const recordDoctorName = record.doctor_name?.trim();
        const matchesDoctor = isDoctorIdFilter
          ? record.doctor_id === doctorFilterValue || (!!selectedDoctorName && recordDoctorName === selectedDoctorName)
          : recordDoctorName === doctorFilterValue;

        if (matchesDoctor && record.patient_id) {
          patientIdsWithDoctor.add(record.patient_id);
        }
      });
      scopedPatients = scopedPatients.filter((patient) => patientIdsWithDoctor.has(patient.id));
    }

    // Apply treatment filter
    if (treatmentFilter) {
      const patientIdsWithTreatment = new Set<string>();
      treatmentRecords.forEach((record) => {
        if (record.description?.trim() === treatmentFilter && record.patient_id) {
          patientIdsWithTreatment.add(record.patient_id);
        }
      });
      scopedPatients = scopedPatients.filter((patient) => patientIdsWithTreatment.has(patient.id));
    }

    if (!searchTerm) return scopedPatients;
    const term = searchTerm.toLowerCase();
    return scopedPatients.filter((patient) => {
      const searchableCreatedDate = formatCreatedDate(patient.created_at).toLowerCase();
      const searchableRawCreatedDate = (patient.created_at || '').toLowerCase();
      const searchableAddress = [patient.address, patient.city, patient.township]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const searchableAge = patient.age !== undefined && patient.age !== null ? String(patient.age) : '';

      return (
        (patient.name || '').toLowerCase().includes(term) ||
        (patient.email || '').toLowerCase().includes(term) ||
        (patient.phone || '').toLowerCase().includes(term) ||
        (patient.patient_unique_id || '').toLowerCase().includes(term) ||
        searchableAddress.includes(term) ||
        searchableAge.includes(term) ||
        searchableCreatedDate.includes(term) ||
        searchableRawCreatedDate.includes(term)
      );
    });
  }, [patients, searchTerm, dateQuickFilter, dateFilter, endDateFilter, visitDateQuickFilter, visitDateFilter, visitEndDateFilter, doctorFilter, treatmentFilter, todayISO, treatmentRecords, doctorNameById, patientLastVisitMap, todayVisitStr, weekAgoStr, monthAgoStr]);

  const cityOptions = useMemo(
    () => getMyanmarCities().map((city) => ({ value: city, label: city })),
    []
  );

  const townshipOptions = useMemo(
    () => getTownshipsForCity(editData.city || '').map((township) => ({ value: township, label: township })),
    [editData.city]
  );

  const activePatientTypeOptions = useMemo(() => {
    const activeNames = patientTypes
      .filter((type) => type.is_active)
      .map((type) => (type.name || '').trim())
      .filter(Boolean);
    return activeNames.length > 0 ? activeNames : [...DEFAULT_PATIENT_TYPE_OPTIONS];
  }, [patientTypes]);

  const normalizePatientType = (value?: string): string => {
    const normalized = (value || '').trim();
    const mappedLegacy = normalized.toLowerCase();
    const legacyMap: Record<string, string> = {
      'walk-in': 'Walk-in',
      online: 'ONP',
      'phone call': 'Rec-ph call',
      hotline: 'Hotline',
      tiktok: 'Tiktok',
      'tiktok hotline': 'Tiktok Hotline',
      onp: 'ONP',
      rnp: 'RNP',
      otp: 'OTP'
    };

    if (normalized && activePatientTypeOptions.includes(normalized)) {
      return normalized;
    }

    return legacyMap[mappedLegacy] || normalized || activePatientTypeOptions[0] || DEFAULT_PATIENT_TYPE_NAME;
  };

  const patientTypeOptionsForEdit = useMemo(() => {
    const currentType = normalizePatientType(editData.patient_type);
    if (!currentType || activePatientTypeOptions.includes(currentType)) {
      return activePatientTypeOptions;
    }
    return [...activePatientTypeOptions, currentType];
  }, [activePatientTypeOptions, editData.patient_type]);

  // Paginated data
  const paginatedPatients = useMemo(() => {
    if (showAll) return filteredPatients;
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredPatients.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredPatients, currentPage, showAll]);

  // Reset to first page when patients change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [patients, dateQuickFilter, dateFilter, endDateFilter, visitDateQuickFilter, visitDateFilter, visitEndDateFilter, doctorFilter, treatmentFilter]);

  const [exporting, setExporting] = useState(false);

  const handleDownloadPDF = async () => {
    if (onExportPDF) {
      setExporting(true);
      try {
        await onExportPDF();
      } finally {
        setExporting(false);
      }
    } else {
      exportPatientsToPDF(filteredPatients, currency, treatmentRecords);
    }
  };

  const handleDownloadExcel = async () => {
    if (onExportExcel) {
      setExporting(true);
      try {
        await onExportExcel();
      } finally {
        setExporting(false);
      }
    } else {
      await exportPatientsToExcel(filteredPatients, currency, treatmentRecords);
    }
  };

  const canRedeem = (patient: Patient) => (patient.loyalty_points || 0) > 0;

  React.useEffect(() => {
    if (!openActionMenuPatientId) return;

    const handleDocumentClick = (event: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setOpenActionMenuPatientId(null);
      }
    };

    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  }, [openActionMenuPatientId]);

  const getPatientAddress = (patient: Patient) => {
    const fullAddress = [patient.address, patient.township, patient.city].filter(Boolean).join(', ');
    return fullAddress || 'N/A';
  };

  const getPatientContact = (patient: Patient) => {
    if (patient.phone && patient.email) return `${patient.phone} / ${patient.email}`;
    return patient.phone || patient.email || 'N/A';
  };

  const handleRedeemClick = (patient: Patient) => {
    setRedeemModal({ open: true, patient });
    setRedeemPointsInput(Math.min(patient.loyalty_points || 0, 1000).toString());
  };

  const openPatientDetails = async (patient: Patient) => {
    setDetailPatient(patient);

    if (Object.prototype.hasOwnProperty.call(treatmentRecordsByPatientId, patient.id)) {
      return;
    }

    setTreatmentRecordsLoadingForPatientId(patient.id);
    try {
      const history = await api.treatments.getHistory(patient.id);
      const sortedHistory = [...history].sort((a, b) => {
        const aTime = new Date(a.date || 0).getTime();
        const bTime = new Date(b.date || 0).getTime();
        return bTime - aTime;
      });
      setTreatmentRecordsByPatientId((prev) => ({
        ...prev,
        [patient.id]: sortedHistory
      }));
    } catch (error) {
      setTreatmentRecordsByPatientId((prev) => ({
        ...prev,
        [patient.id]: []
      }));
    } finally {
      setTreatmentRecordsLoadingForPatientId((prev) => (prev === patient.id ? null : prev));
    }
  };

  const handleRedeemSubmit = () => {
    if (!onRedeemPoints || !redeemModal.patient) return;

    const availablePoints = redeemModal.patient.loyalty_points || 0;
    const points = parseInt(redeemPointsInput, 10);

    if (isNaN(points) || points <= 0 || points > availablePoints) {
      notify(`Please enter a valid amount between 1 and ${availablePoints}.`, 'error');
      return;
    }

    onRedeemPoints(redeemModal.patient, points, 0);
    setRedeemModal({ open: false, patient: null });
    setRedeemPointsInput('');
  };

  return (
  <div className="flex flex-col h-full bg-white overflow-hidden">
    <div className="p-6 border-b border-gray-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white sticky top-0 z-30">
      <div>
        <h2 className="text-xl font-bold text-gray-800">Patient Directory</h2>
        <p className="text-sm text-gray-500">Manage all registered clinical patients</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
        <div className="relative flex-1 sm:flex-initial">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input 
            type="text" 
            placeholder="Search patients..." 
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1); // Reset to first page when searching
            }}
            className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-full sm:w-64"/>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onRefresh?.()}
            className="refresh-action-button flex-1 sm:flex-initial flex items-center justify-center gap-2 border px-4 py-2 rounded-lg text-sm font-bold"
          >
            <RotateCw className="refresh-action-icon w-4 h-4" /> <span className="hidden sm:inline">Refresh</span>
          </button>
          <ExportMenu
            disabled={patients.length === 0 || exporting}
            onExportPDF={handleDownloadPDF}
            onExportExcel={handleDownloadExcel}
            className="flex-1 sm:flex-initial"
          />
          <PatientQRScanButton patients={patients} onSelectPatient={onSelectPatient} />

          <button onClick={onAddPatient} className="flex-1 sm:flex-initial flex items-center justify-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
            <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Add Patient</span>
          </button>
        </div>
      </div>
    </div>
    {/* Unified Filter Bar */}
    <div className="px-4 md:px-6 py-2.5 border-b border-gray-100 bg-white flex flex-col md:flex-row md:items-center gap-2">
      <div className="flex items-center gap-2 text-xs text-gray-500 font-medium min-w-[60px]">
        <Filter size={14} className="text-gray-400" />
        <span className="hidden sm:inline">Filters</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Period quick-select */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          <button
            onClick={() => { setDateQuickFilter('all'); setDateFilter(''); setEndDateFilter(''); setCurrentPage(1); }}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              dateQuickFilter === 'all' && !dateFilter && !endDateFilter
                ? 'bg-white text-indigo-700 shadow-sm border border-gray-200'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            All
          </button>
          <button
            onClick={() => { setDateQuickFilter('new'); setDateFilter(''); setEndDateFilter(''); setCurrentPage(1); }}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              dateQuickFilter === 'new' && !dateFilter && !endDateFilter
                ? 'bg-white text-indigo-700 shadow-sm border border-gray-200'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            New
          </button>
        </div>
        {/* Date range */}
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white pl-2 pr-1">
          <Calendar size={14} className="text-gray-400" />
          <span className="text-[11px] font-semibold text-gray-500">From</span>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => {
              const v = e.target.value;
              setDateFilter(v);
              setDateQuickFilter(v || endDateFilter ? 'custom' : 'all');
              setCurrentPage(1);
            }}
            className="h-7 w-[132px] border-0 px-1 text-[11px] font-medium text-gray-700 focus:outline-none focus:ring-0 bg-transparent"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white pl-2 pr-1">
          <span className="text-[11px] font-semibold text-gray-500">To</span>
          <input
            type="date"
            value={endDateFilter}
            min={dateFilter || undefined}
            onChange={(e) => {
              const v = e.target.value;
              setEndDateFilter(v);
              setDateQuickFilter(dateFilter || v ? 'custom' : 'all');
              setCurrentPage(1);
            }}
            className="h-7 w-[132px] border-0 px-1 text-[11px] font-medium text-gray-700 focus:outline-none focus:ring-0 bg-transparent"
          />
        </div>
        {/* Visit Date Filter */}
        <select
          value={visitDateQuickFilter}
          onChange={(e) => {
            const v = e.target.value as typeof visitDateQuickFilter;
            setVisitDateQuickFilter(v);
            setCurrentPage(1);
            if (v !== 'custom') { setVisitDateFilter(''); setVisitEndDateFilter(''); }
          }}
          className="h-7 rounded-lg border border-teal-200 bg-teal-50/50 px-2 text-[11px] font-semibold text-teal-700 outline-none focus:ring-2 focus:ring-teal-500/30 cursor-pointer"
        >
          <option value="all">🦷 All Visits</option>
          <option value="today">📅 Visited Today</option>
          <option value="week">📆 This Week</option>
          <option value="month">🗓️ This Month</option>
          <option value="custom">📋 Custom Range</option>
        </select>
        {visitDateQuickFilter === 'custom' && (
          <div className="flex items-center gap-1.5">
            <input type="date" value={visitDateFilter} onChange={(e) => { setVisitDateFilter(e.target.value); setCurrentPage(1); }}
              className="h-7 rounded-lg border border-teal-200 bg-teal-50/50 px-2 text-[11px] font-semibold text-teal-700 outline-none focus:ring-2 focus:ring-teal-500/30" />
            <span className="text-[11px] text-gray-400">to</span>
            <input type="date" value={visitEndDateFilter} onChange={(e) => { setVisitEndDateFilter(e.target.value); setCurrentPage(1); }}
              className="h-7 rounded-lg border border-teal-200 bg-teal-50/50 px-2 text-[11px] font-semibold text-teal-700 outline-none focus:ring-2 focus:ring-teal-500/30" />
          </div>
        )}
        {/* Doctor */}
        <select
          value={doctorFilter}
          onChange={(e) => { setDoctorFilter(e.target.value); setCurrentPage(1); }}
          className="h-7 rounded-lg border border-gray-200 px-2 text-[11px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white min-w-[120px] max-w-[160px]"
        >
          <option value=''>Doctor</option>
          {doctorOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {/* Treatment */}
        <select
          value={treatmentFilter}
          onChange={(e) => { setTreatmentFilter(e.target.value); setCurrentPage(1); }}
          className="h-7 rounded-lg border border-gray-200 px-2 text-[11px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white min-w-[120px] max-w-[180px]"
        >
          <option value=''>Treatment</option>
          {treatmentOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {/* Reset */}
        {(dateQuickFilter !== 'all' || dateFilter || endDateFilter || visitDateQuickFilter !== 'all' || visitDateFilter || visitEndDateFilter || doctorFilter || treatmentFilter) && (
          <button
            onClick={() => { setDateQuickFilter('all' as const); setDateFilter(''); setEndDateFilter(''); setVisitDateQuickFilter('all'); setVisitDateFilter(''); setVisitEndDateFilter(''); setDoctorFilter(''); setTreatmentFilter(''); setCurrentPage(1); }}
            className="h-7 px-2.5 rounded-lg border border-gray-200 text-[11px] font-semibold text-gray-500 hover:bg-gray-50 transition-colors bg-white"
          >
            Reset
          </button>
        )}
      </div>
    </div>
    {detailPatient ? (
      <div className="flex-1 overflow-y-auto p-6 bg-slate-50/40">
        {(() => {
          const treatmentRecords = treatmentRecordsByPatientId[detailPatient.id] || [];
          const isTreatmentRecordsLoading = treatmentRecordsLoadingForPatientId === detailPatient.id;
          return (
        <div className="mx-auto w-full max-w-6xl space-y-5">
          <button
            onClick={() => setDetailPatient(null)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeft size={16} />
            Back to Patient List
          </button>

          <div className="overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-sm">
            <div className="bg-gradient-to-r from-indigo-600 via-indigo-500 to-sky-500 px-6 py-6 text-white">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                <div className="flex items-center gap-4">
                  <div className="h-16 w-16 rounded-2xl bg-white/20 backdrop-blur flex items-center justify-center text-2xl font-bold">
                    {detailPatient.name?.charAt(0) || '?'}
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-white/90 font-semibold">Patient Profile</p>
                    <h3 className="text-2xl font-bold leading-tight">{detailPatient.name || 'N/A'}</h3>
                    <p className="mt-1 text-sm text-white/90">
                      Created: {formatCreatedDate(detailPatient.created_at)} • Operator: {detailPatient.patient_type || 'N/A'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Contact</p>
                  <p className="mt-2 text-sm font-semibold text-gray-900">{getPatientContact(detailPatient)}</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Portal Access</p>
                    <p className="mt-2 text-sm font-semibold text-gray-900">{detailPatient.has_account ? 'Active' : 'No Access'}</p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Balance</p>
                    <p className="mt-2 text-sm font-semibold text-gray-900">{formatCurrency(detailPatient.balance || 0, currency)}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Patient Note</p>
                  <p className="mt-2 text-sm leading-6 text-gray-900 whitespace-pre-wrap">
                    {detailPatient.medicalHistory?.trim() || 'No patient note available.'}
                  </p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Treatment and Diagnosis</p>
                  {isTreatmentRecordsLoading ? (
                    <p className="mt-2 text-sm leading-6 text-gray-900">Loading treatment records...</p>
                  ) : treatmentRecords.length === 0 ? (
                    <p className="mt-2 text-sm leading-6 text-gray-900">No Treatment and Diagnosis records available.</p>
                  ) : (
                    <div className="mt-3 space-y-2 max-h-52 overflow-y-auto pr-1">
                      {treatmentRecords.map((record) => (
                        <div key={record.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                          <p className="text-sm font-semibold text-gray-900">{record.description || 'Treatment'}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Date: {formatCreatedDate(record.date)}{typeof record.cost === 'number' ? ` • Charge: ${formatCurrency(record.cost, currency)}` : ''}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Doctor: {formatDoctorName(record.doctor_name)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Address</p>
                  <p className="mt-2 text-sm text-gray-900">{getPatientAddress(detailPatient)}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white p-4 lg:col-span-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Patient Meta</p>
                  <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-gray-500">Patient ID</p>
                      <p className="font-semibold text-gray-900">
                        {(() => {
                          const pid = detailPatient.patient_unique_id || 'N/A';
                          if (pid === 'N/A' || pid.length <= 5) return pid;
                          if (showFullPatientId) {
                            return <>{pid} <button onClick={() => setShowFullPatientId(false)} className="text-xs text-indigo-600 hover:underline">less</button></>;
                          }
                          return <>{pid.substring(0, 5)}... <button onClick={() => setShowFullPatientId(true)} className="text-xs text-indigo-600 hover:underline">see more</button></>;
                        })()}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-500">Age</p>
                      <p className="font-semibold text-gray-900">{detailPatient.age ?? 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Created Date</p>
                      <p className="font-semibold text-gray-900">{formatCreatedDate(detailPatient.created_at)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Loyalty Point</p>
                      <p className="font-semibold text-gray-900">{detailPatient.loyalty_points || 0}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
          );
        })()}
      </div>
    ) : loading ? (
      <div className="flex-1 flex items-center justify-center p-12"><Loader2 className="animate-spin text-[var(--hover-600)] w-10 h-10" /></div>
    ) : patients.length === 0 ? (
      <div className="flex-1 flex items-center justify-center p-12 text-center text-gray-400 italic">No patients found. Add your first patient to begin.</div>
    ) : (
      <>
        {/* Desktop Table View */}
        <div className="hidden md:block flex-1 min-h-0 p-6 pt-0 overflow-hidden">
          <div className="h-full rounded-2xl border border-indigo-200 bg-white shadow-sm overflow-hidden">
            <div className="h-full overflow-auto">
              <table className="min-w-[1040px] w-full text-sm">
                <thead className="bg-indigo-50 border-b border-indigo-200">
                  <tr className="text-indigo-700">
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">No</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide w-[168px] min-w-[168px]">Name</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">Created Date</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide text-teal-700">
                      <div className="flex items-center gap-1.5">
                        <Calendar size={12} className="text-teal-500" />
                        Last Visit
                      </div>
                    </th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">Age</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">Contact</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide w-[140px] min-w-[140px]">Address</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">Treatment</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">Doctor</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-left font-bold uppercase text-xs tracking-wide">Balance</th>
                    <th className="sticky top-0 z-20 bg-indigo-50 px-3 py-3 text-right font-bold uppercase text-xs tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedPatients.map((patient, index) => {
                        const patientRecords = treatmentRecordsByPatientIdMap.get(patient.id) || [];
                        const nextAppointment = nextAppointmentByPatientId.get(patient.id);
                        return (
                    <tr
                      key={patient.id}
                      className={`transition-colors group cursor-pointer border-b border-gray-100 last:border-b-0 ${dateQuickFilter === 'new' ? isNewPatientToday(patient)
                            ? 'bg-emerald-50/70 hover:bg-emerald-100/70'
                            : 'bg-amber-50/70 hover:bg-amber-100/70'
                          : 'hover:bg-indigo-50/30'
                      }`}
                      onClick={() => onSelectPatient(patient)}
                    >
                      <td className="px-3 py-3 align-top font-semibold text-gray-700">
                        {showAll ? index + 1 : (currentPage - 1) * itemsPerPage + index + 1}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="flex items-center">
                          <div className="theme-accent-soft-bg theme-accent-text h-9 w-9 rounded-full flex items-center justify-center font-bold mr-3">
                            {patient.name?.charAt(0) || '?'}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-semibold text-gray-900 group-hover:text-indigo-700">{patient.name}</div>
                              {dateQuickFilter === 'new' && (
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
                                    isNewPatientToday(patient)
                                      ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                                      : 'bg-amber-100 text-amber-700 border-amber-200'
                                  }`}
                                >
                                  {isNewPatientToday(patient) ? 'New' : 'Old'}
                                </span>
                              )}
                            </div>
                            <div className="patient-next-appointment-chip mt-1 inline-flex items-center rounded-md px-2.5 py-1 text-xs font-bold">
                              Next : {formatAppointmentDate(nextAppointment?.date)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top text-gray-700 whitespace-nowrap">
                        {formatCreatedDate(patient.created_at)}
                      </td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        {patientLastVisitMap.get(patient.id) ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200">
                            <Calendar size={10} className="text-teal-500" />
                            {formatDate(patientLastVisitMap.get(patient.id)!)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 italic">No visits</span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top text-gray-700">
                        {patient.age ?? 'N/A'}
                      </td>
                      <td className="px-3 py-3 align-top text-gray-700">
                        {getPatientContact(patient)}
                      </td>
                      <td className="w-[140px] max-w-[140px] px-3 py-3 align-top text-gray-700" title={getPatientAddress(patient)}>
                        <div className="whitespace-normal break-words leading-snug line-clamp-2">
                          {getPatientAddress(patient)}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top text-gray-700 max-w-[200px]">
                        <div className="text-[11px] font-medium text-gray-700 leading-tight max-h-[48px] overflow-y-auto space-y-0.5" title={patientRecords.map(r => r.description).filter(Boolean).join(', ')}>
                          {patientRecords.length > 0 ? (
                            patientRecords.slice(0, 4).map((r, i) => (
                              <div key={i} className="flex items-start gap-1">
                                <span className="text-indigo-400 mt-0.5 shrink-0">•</span>
                                <span className="truncate">{r.description}</span>
                              </div>
                            ))
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                          {patientRecords.length > 4 && (
                            <div className="text-[10px] text-gray-400 font-medium mt-0.5">+{patientRecords.length - 4} more</div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top text-gray-700">
                        <div className="text-[11px] font-medium text-gray-700 leading-tight max-h-[48px] overflow-y-auto space-y-0.5">
                          {patientRecords.length > 0 ? (
                            getUniquePatientDoctorNames(patientRecords).slice(0, 2).map((name, i) => (
                              <div key={i} className="flex items-start gap-1">
                                <span className="text-gray-400 mt-0.5 shrink-0">•</span>
                                <span className="truncate">{formatDoctorName(name)}</span>
                              </div>
                            ))
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                          {getUniquePatientDoctorNames(patientRecords).length > 2 && (
                            <div className="text-[10px] text-gray-400 font-medium mt-0.5">+{getUniquePatientDoctorNames(patientRecords).length - 2} more</div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        {patient.balance > 0 ? (
                          <span className="text-red-600 font-bold bg-red-50 px-2 py-1 rounded border border-red-100">{formatCurrency(patient.balance || 0, currency)}</span>
                        ) : (
                          <span className="text-green-600 font-medium">Clear</span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top text-right">
                        <div className="relative inline-flex items-center justify-end gap-2" ref={openActionMenuPatientId === patient.id ? actionMenuRef : undefined}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditPatientModal(patient);
                            }}
                            className="text-indigo-600 hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-2 py-1 rounded flex items-center gap-1 transition-colors"
                            title="Edit patient profile"
                          >
                            <Edit size={14} /> Edit
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectPatient(patient);
                            }}
                            className="text-indigo-600 hover:text-indigo-900 flex items-center gap-1"
                          >
                            View Chart <ChevronRight size={14} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenActionMenuPatientId((prev) => (prev === patient.id ? null : patient.id));
                            }}
                            className="inline-flex items-center justify-center rounded-lg p-2 text-gray-600 hover:bg-gray-100"
                            title="Open actions"
                          >
                            <MoreVertical size={16} />
                          </button>
                          {openActionMenuPatientId === patient.id && (
                            <div className="absolute right-0 top-10 z-20 w-44 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openPatientDetails(patient);
                                  setOpenActionMenuPatientId(null);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                              >
                                View Details
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                      })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Mobile Card View */}
        <div className="md:hidden divide-y divide-gray-100 overflow-y-auto flex-1 min-h-0">
          {paginatedPatients.map((patient) => {
            const nextAppointment = nextAppointmentByPatientId.get(patient.id);
            return (
            <div 
              key={patient.id} 
              className={`p-4 transition-colors ${
                dateQuickFilter === 'new'
                  ? isNewPatientToday(patient)
                    ? 'bg-emerald-50/70 hover:bg-emerald-100/70'
                    : 'bg-amber-50/70 hover:bg-amber-100/70'
                  : 'hover:bg-gray-50 active:bg-indigo-50'
              }`}
              onClick={() => onSelectPatient(patient)}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="theme-accent-soft-bg theme-accent-text h-10 w-10 rounded-full flex items-center justify-center font-bold">
                    {patient.name?.charAt(0) || '?'}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="font-bold text-gray-900">{patient.name}</div>
                      {dateQuickFilter === 'new' && (
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
                            isNewPatientToday(patient)
                              ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                              : 'bg-amber-100 text-amber-700 border-amber-200'
                          }`}
                        >
                          {isNewPatientToday(patient) ? 'New' : 'Old'}
                        </span>
                      )}
                      {patient.has_account ? (
                        <ShieldCheck size={12} className="text-green-500" />
                      ) : (
                        <ShieldAlert size={12} className="text-gray-300" />
                      )}
                    </div>
                    <div className="patient-next-appointment-chip mt-1 inline-flex items-center rounded-md px-2.5 py-1 text-xs font-bold">
                      Next : {formatAppointmentDate(nextAppointment?.date)}
                    </div>
                    <div className="text-xs text-gray-500">{patient.phone}</div>
                    <div className="text-[11px] text-gray-400 mt-1">Created Date: {formatCreatedDate(patient.created_at)}</div>
                    <div className="text-[11px] text-gray-400 mt-1">
                      Last Visit:{' '}
                      {patientLastVisitMap.get(patient.id) ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200">
                          <Calendar size={9} className="text-teal-500" />
                          {formatDate(patientLastVisitMap.get(patient.id)!)}
                        </span>
                      ) : (
                        <span className="text-gray-400 italic">No visits</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openPatientDetails(patient);
                    }}
                    className="text-xs font-semibold text-indigo-600 px-2 py-1 rounded-md hover:bg-indigo-50"
                  >
                    Details
                  </button>
                  <ChevronRight size={18} className="text-gray-300" />
                </div>
              </div>
              
              <div className={`grid ${loyaltyEnabled ? 'grid-cols-2' : 'grid-cols-1'} gap-2 mt-4`}>
                <div className="bg-gray-50 p-2 rounded-lg">
                  <p className="text-[10px] text-gray-400 uppercase font-bold tracking-wider mb-0.5">Balance</p>
                  <p className={`text-sm font-bold ${patient.balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {formatCurrency(patient.balance || 0, currency)}
                  </p>
                </div>
                {loyaltyEnabled && (
                  <div className="bg-amber-50 p-2 rounded-lg">
                    <p className="text-[10px] text-amber-600 uppercase font-bold tracking-wider mb-0.5">Points</p>
                    <p className="text-sm font-bold text-amber-700 flex items-center gap-1">
                      <Award size={12} /> {patient.loyalty_points || 0}
                    </p>
                  </div>
                )}
              </div>
              
              {patient.medicalHistory && (
                <div className="mt-3 px-3 py-1.5 bg-orange-50 border border-orange-100 rounded-lg text-[11px] text-orange-700 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></span>
                  Medical Review Required
                </div>
              )}

              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  openEditPatientModal(patient);
                }}
                className="w-full mt-2 py-2 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-bold border border-indigo-100 flex items-center justify-center gap-2"
              >
                <Edit size={14} /> Edit Profile
              </button>
              
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setAuthModal({ open: true, patient });
                  setNewPassword('');
                }}
                className="w-full mt-2 py-2 bg-amber-50 text-amber-700 rounded-lg text-xs font-bold border border-amber-100 flex items-center justify-center gap-2"
              >
                <User size={14} /> {patient.has_account ? 'Update Portal Account' : 'Setup Portal Account'}
              </button>

              {loyaltyEnabled && onRedeemPoints && canRedeem(patient) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRedeemClick(patient);
                  }}
                  className="w-full mt-2 py-2 bg-amber-50 text-amber-700 rounded-lg text-xs font-bold border border-amber-100 flex items-center justify-center gap-2"
                >
                  <Award size={14} /> Redeem
                </button>
              )}
            </div>
          )})}
        </div>
      </>
    )}
    {!detailPatient && !loading && patients.length > 0 && (
      <div className="sticky bottom-0 bg-white border-t border-gray-100">
        <Pagination
          totalItems={filteredPatients.length}
          itemsPerPage={itemsPerPage}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          showAll={showAll}
          onToggleShowAll={() => setShowAll(!showAll)}
          showAllToggle={false}
        />
      </div>
    )}

    {authModal.open && authModal.patient && (
      <Modal 
        title={authModal.patient.has_account ? "Update Portal Account" : "Setup Portal Account"} 
        onClose={() => setAuthModal({ open: false, patient: null })}
      >
        <div className="space-y-6">
          <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center shadow-sm">
              <User className="text-indigo-600" />
            </div>
            <div>
              <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Patient Name</p>
              <h4 className="text-lg font-black text-indigo-900">{authModal.patient.name}</h4>
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-gray-500 leading-relaxed">
              {authModal.patient.has_account 
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
              onClick={() => setAuthModal({ open: false, patient: null })}
              className="flex-1 px-6 py-3 rounded-xl font-bold text-gray-400 hover:bg-gray-50 transition-all border border-transparent"
            >
              Cancel
            </button>
            <button 
              disabled={newPassword.length < 4}
              onClick={async () => {
                if (onUpdatePatientAuth && authModal.patient) {
                  try {
                    await onUpdatePatientAuth(authModal.patient, newPassword);
                    setAuthModal({ open: false, patient: null });
                  } catch {
                    // The caller reports the error; keep this modal open so it can be corrected.
                  }
                }
              }}
              className="flex-1 bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Key size={18} />
              {authModal.patient.has_account ? "Update Password" : "Create Account"}
            </button>
          </div>
        </div>
      </Modal>
    )}

    {editModal.open && editModal.patient && (
      <Modal title="Edit Patient Profile" onClose={() => setEditModal({ open: false, patient: null })}>
        <form 
          onSubmit={async (e) => {
            e.preventDefault();
            if (isSubmitting) return;
            if (!editData.location_id) {
              notify('Please select a branch/location for this patient.', 'error');
              return;
            }
            setIsSubmitting(true);
                       try {
                         if (onUpdatePatient && editModal.patient) {
                           const patientData: Partial<Patient> = {
                  location_id: editData.location_id,
                  name: editData.name,
                  email: editData.email,
                  phone: editData.phone,
                  medicalHistory: editData.medicalHistory,
                  age: editData.age ? parseInt(editData.age) : undefined,
                  address: editData.address || undefined,
                  city: editData.city || undefined,
                  township: editData.township || undefined,
                  patient_type: editData.patient_type
                           };
                           await onUpdatePatient(editModal.patient.id, patientData);
                           setEditModal({ open: false, patient: null });
                         }
                       } catch (err: any) {
                         if (isBranchTransferValidationError(err) && editModal.patient) {
                           const recordState = await api.patients.checkPatientRecords(editModal.patient.id);
                           setBranchTransferBlockedRecords(getBranchTransferBlockedItems(recordState));
                           setBranchTransferBlockedOpen(true);
                         }
                       } finally {
                         setIsSubmitting(false);
                       }
          }} 
          className="space-y-6"
        >
          <div className="flex items-center gap-4 p-5 bg-gray-50 rounded-2xl border border-gray-100 mb-2">
            <div className="bg-indigo-100 text-indigo-600 w-12 h-12 rounded-full flex items-center justify-center font-bold text-xl">
              {editModal.patient.name.charAt(0)}
            </div>
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Editing Patient</p>
              <h4 className="text-lg font-bold text-gray-900">{editModal.patient.name}</h4>
            </div>
          </div>

          {/* ═══ PERSONAL INFORMATION ═══ */}
          <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
              Personal Information
            </h3>
            <Input label="Full Patient Name" required value={editData.name} onChange={(e: any) => setEditData({...editData, name: e.target.value})} />
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Age</label>
                <input
                  type="number"
                  min="0"
                  max="150"
                  className="w-full border-gray-200 border rounded-2xl p-3 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all"
                  value={editData.age}
                  onChange={(e) => setEditData({...editData, age: e.target.value})}
                  placeholder="Enter age"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Patient Type</label>
                <select
                  className="w-full border-gray-200 border rounded-2xl p-3 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all bg-white"
                  value={editData.patient_type}
                  onChange={(e) => setEditData({...editData, patient_type: e.target.value})}
                >
                  {patientTypeOptionsForEdit.map((patientType) => (
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
            <div className="grid grid-cols-2 gap-4">
              <Input label="Primary Email" type="email" value={editData.email} onChange={(e: any) => setEditData({...editData, email: e.target.value})} />
              <Input label="Mobile Contact" required value={editData.phone} onChange={(e: any) => setEditData({...editData, phone: e.target.value})} />
            </div>
          </div>

          {/* ═══ LOCATION ═══ */}
          <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
              Location
            </h3>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Branch / Location</label>
              <select
                required
                className="w-full border-gray-200 border rounded-2xl p-3 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all bg-white"
                value={editData.location_id}
                onChange={(e) => setEditData({...editData, location_id: e.target.value})}
              >
                <option value="">Select a branch...</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>{loc.name}</option>
                ))}
              </select>
              {editModal.patient.location_id !== editData.location_id && editData.location_id && (
                <p className="mt-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  Saving will transfer this patient profile and portal access to the selected branch.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">City</label>
                <SearchableSelect
                  value={editData.city || ''}
                  onChange={(selectedCity) => {
                    const allowedTownships = getTownshipsForCity(selectedCity);
                    const nextTownship = allowedTownships.includes(editData.township || '') ? editData.township : '';
                    setEditData({ ...editData, city: selectedCity, township: nextTownship });
                  }}
                  options={cityOptions}
                  placeholder="Select City"
                  emptyMessage="No city found"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase mb-1.5">Township</label>
                <SearchableSelect
                  value={editData.township || ''}
                  onChange={(selectedTownship) => setEditData({ ...editData, township: selectedTownship })}
                  options={townshipOptions}
                  placeholder={editData.city ? 'Select Township' : 'Select City first'}
                  emptyMessage={editData.city ? 'No township found for this city' : 'Choose city first'}
                />
              </div>
            </div>
          </div>

          {/* ═══ ADDRESS ═══ */}
          <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
              Address
            </h3>
            <Input label="Street Address" placeholder="Street address" value={editData.address} onChange={(e: any) => setEditData({...editData, address: e.target.value})} />
          </div>

          {/* ═══ MEDICAL HISTORY ═══ */}
          <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <span className="w-1 h-5 bg-indigo-500 rounded-full"></span>
              Medical History
            </h3>
            <textarea className="w-full border-gray-200 border rounded-2xl p-4 text-sm focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all min-h-[100px]" rows={4}
              value={editData.medicalHistory} onChange={e => setEditData({...editData, medicalHistory: e.target.value})} />
          </div>
          <button 
            type="submit" 
            disabled={isSubmitting}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3.5 rounded-2xl font-semibold text-sm shadow-lg shadow-indigo-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {isSubmitting ? 'Saving Changes...' : 'Save Changes'}
          </button>

          {onDeletePatient && (
            <button
              type="button"
              onClick={() => {
                // Close the edit modal first so the delete confirmation
                // dialog is not visually obscured by the edit modal.
                const patientToDelete = editModal.patient;
                setEditModal({ open: false, patient: null });
                // Use a microtask to ensure the edit modal unmounts
                // before the confirm dialog opens, preventing z-index overlap.
                queueMicrotask(() => {
                  deletePatientIdRef.current = patientToDelete?.id || null;
                  deletePatientNameRef.current = patientToDelete?.name || 'this patient';
                  setDeleteConfirmOpen(true);
                });
              }}
              className="w-full bg-red-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-red-600/20 hover:bg-red-700 transition-all mt-2"
            >
              Delete Patient
            </button>
          )}
        </form>
      </Modal>
    )}

    {/* Delete Confirmation Dialog */}
    <ConfirmDialog
      isOpen={deleteConfirmOpen}
      title="Delete Patient"
      message={`Are you sure you want to delete ${deletePatientNameRef.current}? This will permanently remove the patient and all related records. This action cannot be undone.`}
      confirmText="Delete Patient"
      cancelText="Cancel"
      type="danger"
      isLoading={isDeleting}
      onConfirm={async () => {
        const patientId = deletePatientIdRef.current;
        if (!patientId || !onDeletePatient) return;
        setIsDeleting(true);
        try {
          await onDeletePatient(patientId);
          setDeleteConfirmOpen(false);
          notify('Patient deleted successfully.', 'success');
        } catch (err: any) {
          notify(err?.message || 'Failed to delete patient', 'error');
        } finally {
          setIsDeleting(false);
          deletePatientIdRef.current = null;
          deletePatientNameRef.current = 'this patient';
        }
      }}
      onCancel={() => {
        setDeleteConfirmOpen(false);
        deletePatientIdRef.current = null;
        deletePatientNameRef.current = 'this patient';
      }}
    />

    {branchTransferBlockedOpen && (
      <Modal
        title="Branch Transfer Blocked"
        onClose={() => {
          setBranchTransferBlockedOpen(false);
          setBranchTransferBlockedRecords([]);
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
                  This patient cannot be transferred to another branch.
                </p>
                <p className="mt-2 text-sm leading-6 text-gray-600">
                  Existing branch-linked history was found for this patient.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">
              Why This Is Blocked
            </p>
            <p className="mt-2 text-sm leading-6 text-gray-700">
              This patient has existing records in the current branch:
            </p>
            <ul className="mt-3 space-y-2">
              {branchTransferBlockedRecords.map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm leading-6 text-gray-700">
              Resolve or move these records first before transferring the patient to another branch.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              setBranchTransferBlockedOpen(false);
              setBranchTransferBlockedRecords([]);
            }}
            className="w-full rounded-2xl bg-amber-600 px-5 py-3.5 text-sm font-black text-white shadow-lg shadow-amber-600/20 transition-all hover:bg-amber-700 hover:shadow-amber-700/25"
          >
            Understood
          </button>
        </div>
      </Modal>
    )}

    {redeemModal.open && redeemModal.patient && (
      <Modal
        title="Redeem Loyalty Points"
        onClose={() => {
          setRedeemModal({ open: false, patient: null });
          setRedeemPointsInput('');
        }}
      >
        <div className="space-y-5">
          <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100">
            <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Patient</p>
            <p className="text-lg font-black text-amber-900">{redeemModal.patient.name}</p>
            <p className="text-sm text-amber-700 mt-1">Available Points: <span className="font-bold">{redeemModal.patient.loyalty_points || 0}</span></p>
          </div>

          <Input
            label="Points to Redeem"
            type="number"
            min={1}
            max={redeemModal.patient.loyalty_points || 0}
            value={redeemPointsInput}
            onChange={(e: any) => setRedeemPointsInput(e.target.value)}
            autoFocus
          />

          <div className="flex gap-3">
            <button
              onClick={() => {
                setRedeemModal({ open: false, patient: null });
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


  </div>
  );
};

export default PatientsView;

