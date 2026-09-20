import React, { useMemo, useState } from 'react';
import { ArrowLeftRight, Beaker, Loader2, Package, Plus, RotateCw, Search, Stethoscope } from 'lucide-react';
import type { ClinicalRecord, PaymentRecord, TreatmentCostSummary } from '../types';
import { api } from '../services/api';
import { formatCurrency, type Currency } from '../utils/currency';
import { toLocalISODate } from '../utils/auditLogFilters';
import { formatTeethWithPosition } from '../utils/toothNumbering';
import { formatDoctorName, normalizeDoctorName } from '../utils/doctorName';
import { buildMaterialPaymentHistoryRows, filterMaterialPaymentHistoryRows } from '../utils/materialPaymentHistory';
import Pagination from './Pagination';
import MaterialCostModal from './MaterialCostModal';

interface MaterialCostViewProps {
  records: ClinicalRecord[];
  paymentRecords: PaymentRecord[];
  loading: boolean;
  currency: Currency;
  canManageMaterials: boolean;
  onRefresh: () => void | Promise<void>;
  // Optional fast path after a cost save: refresh only the affected patient's
  // rows instead of reloading every clinic record, payment, and dashboard metric.
  onCostsSaved?: (patientId?: string | null) => Promise<void> | void;
}

type MaterialCostFilter = 'all' | 'tomorrow' | 'today' | 'custom';
type MaterialCostRow = {
  paymentId: string;
  collectedAmount: number;
  doctorEarned: number;
  record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] };
};

const getTreatmentRecordIds = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }) => {
  const groupedRecords = record._groupedRecords?.length ? record._groupedRecords : [record];
  return groupedRecords.map((item) => item.id).filter(Boolean);
};

const MaterialCostView: React.FC<MaterialCostViewProps> = ({ records, paymentRecords, loading, currency, canManageMaterials, onRefresh, onCostsSaved }) => {
  const summaryRequestVersion = React.useRef(0);
  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [patientSearchTerm, setPatientSearchTerm] = useState('');
  const [doctorSearchTerm, setDoctorSearchTerm] = useState('');
  const [treatmentSearchTerm, setTreatmentSearchTerm] = useState('');
  const [materialFilter, setMaterialFilter] = useState<MaterialCostFilter>('today');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTableScrollable, setIsTableScrollable] = useState(false);
  const [editingRecord, setEditingRecord] = useState<(ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }) | null>(null);
  const [materialSummaries, setMaterialSummaries] = useState<Record<string, TreatmentCostSummary>>({});
  const todayKey = useMemo(() => toLocalISODate(new Date()), []);
  const tomorrowKey = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return toLocalISODate(tomorrow);
  }, []);
  const [dateFrom, setDateFrom] = useState(todayKey);
  const [dateTo, setDateTo] = useState(todayKey);
  const isTodayRange = dateFrom === todayKey && dateTo === todayKey;
  const itemsPerPage = 10;

  const paymentHistoryRows = useMemo(
    () => filterMaterialPaymentHistoryRows(
      buildMaterialPaymentHistoryRows(records, paymentRecords),
      { dateFrom, dateTo, patientSearchTerm, doctorSearchTerm, treatmentSearchTerm }
    ),
    [records, paymentRecords, dateFrom, dateTo, patientSearchTerm, doctorSearchTerm, treatmentSearchTerm]
  );

  const statusFilteredRows = useMemo<MaterialCostRow[]>(() => {
    const recordById = new Map(records.map((record) => [record.id, record]));
    return paymentHistoryRows.flatMap((paymentRow) => {
      const linkedRecords = paymentRow.treatmentIds
        .map((id) => recordById.get(id))
        .filter((record): record is ClinicalRecord => !!record);
      if (linkedRecords.length === 0) return [];

      const doctorNames = Array.from(new Map(
        linkedRecords
          .map((record) => normalizeDoctorName(record.doctor_name))
          .filter(Boolean)
          .map((name) => [name.toLocaleLowerCase(), name])
      ).values());
      const record = {
        ...linkedRecords[0],
        date: paymentRow.date,
        patient_name: paymentRow.patientName,
        patient_unique_id: paymentRow.patientUniqueId,
        patient_balance: paymentRow.balanceAfter,
        doctor_name: doctorNames.length > 0 ? doctorNames.join(', Dr. ') : undefined,
        teeth: [...new Set(linkedRecords.flatMap((item) => item.teeth || []))].sort((a, b) => a - b),
        _groupedRecords: linkedRecords
      };

      return [{
        paymentId: paymentRow.id,
        collectedAmount: paymentRow.totalPaid,
        doctorEarned: paymentRow.doctorEarned,
        record
      }];
    });
  }, [paymentHistoryRows, records]);

  const loadMaterialSummaries = React.useCallback(async (rowsToLoad: MaterialCostRow[]) => {
    const requestVersion = ++summaryRequestVersion.current;
    const treatmentIds = rowsToLoad.flatMap((row) => getTreatmentRecordIds(row.record));
    if (treatmentIds.length === 0) {
      return;
    }

    try {
      const summaries = await api.materialCosts.getTotalsByTreatmentIds(treatmentIds);
      if (requestVersion !== summaryRequestVersion.current) return;
      setMaterialSummaries((current) => {
        const next = { ...current };
        treatmentIds.forEach((treatmentId) => {
          delete next[treatmentId];
        });
        return { ...next, ...summaries };
      });
    } catch (error) {
      console.warn('Unable to refresh material cost summaries. Keeping current table totals.', error);
    }
  }, []);

  const renderPatientBalance = (balance?: number | null) => {
    if (balance === null || balance === undefined) return <span className="text-slate-400">-</span>;
    const numericBalance = Number(balance || 0);
    return (
      <span className={numericBalance > 0 ? 'font-bold text-red-600' : 'font-semibold text-green-600'}>
        {numericBalance > 0 ? formatCurrency(numericBalance, currency) : 'Clear'}
      </span>
    );
  };

  const renderTreatmentDescriptionList = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }) => {
    const groupedRecords = record._groupedRecords?.length ? record._groupedRecords : [record];
    return (
      <div className="space-y-1">
        {groupedRecords.map((item, index) => (
          <div key={`${item.id || index}-${index}`} className="flex min-w-0 items-start gap-1.5">
            <span className="mt-0.5 shrink-0 text-green-600">&bull;</span>
            <span className="min-w-0 break-words">{item.description || 'Treatment record'}</span>
          </div>
        ))}
      </div>
    );
  };

  const getMaterialTotal = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }) => {
    return getTreatmentRecordIds(record).reduce((sum, treatmentId) => {
      return sum + Number(materialSummaries[treatmentId]?.totalAmount || 0);
    }, 0);
  };

  const getTypedCostTotal = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }, costType: 'material' | 'lab' | 'special_doctor') => {
    const key = costType === 'lab' ? 'labTotal' : costType === 'special_doctor' ? 'specialDoctorTotal' : 'materialTotal';
    return getTreatmentRecordIds(record).reduce((sum, treatmentId) => sum + Number(materialSummaries[treatmentId]?.[key] || 0), 0);
  };

  const getTreatmentAmount = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }) => {
    const groupedRecords = record._groupedRecords?.length ? record._groupedRecords : [record];
    return groupedRecords.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  };

  const getNetReceive = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }, collectedAmount: number) => {
    return Math.max(0, collectedAmount - getMaterialTotal(record));
  };

  const getNetProfit = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }, collectedAmount: number, doctorEarned: number) => {
    return collectedAmount - getMaterialTotal(record) - doctorEarned;
  };

  const paginatedRows = useMemo(() => {
    if (showAll) return statusFilteredRows;
    const startIndex = (currentPage - 1) * itemsPerPage;
    return statusFilteredRows.slice(startIndex, startIndex + itemsPerPage);
  }, [statusFilteredRows, currentPage, showAll]);

  React.useEffect(() => {
    if (loading) return;
    void loadMaterialSummaries(paginatedRows);
  }, [loading, loadMaterialSummaries, paginatedRows]);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [records, patientSearchTerm, doctorSearchTerm, treatmentSearchTerm, dateFrom, dateTo, materialFilter]);

  React.useEffect(() => {
    if (loading) {
      setIsTableScrollable(false);
      return;
    }

    const scrollContainer = tableScrollRef.current;
    if (!scrollContainer) return;

    const updateScrollableState = () => {
      setIsTableScrollable(scrollContainer.scrollWidth > scrollContainer.clientWidth + 1);
    };

    updateScrollableState();
    window.addEventListener('resize', updateScrollableState);

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateScrollableState)
      : null;
    resizeObserver?.observe(scrollContainer);
    const table = scrollContainer.querySelector('table');
    if (table) resizeObserver?.observe(table);

    return () => {
      window.removeEventListener('resize', updateScrollableState);
      resizeObserver?.disconnect();
    };
  }, [loading]);

  const renderTypedCost = (record: ClinicalRecord & { _groupedRecords?: ClinicalRecord[] }, costType: 'material' | 'lab' | 'special_doctor') => {
    const totalAmount = getTypedCostTotal(record, costType);
    if (totalAmount <= 0) return <span className="text-slate-400">-</span>;
    const isLab = costType === 'lab';
    const isSpecialDoctor = costType === 'special_doctor';
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-black ${isLab ? 'border-violet-100 bg-violet-50 text-violet-700' : isSpecialDoctor ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-cyan-100 bg-cyan-50 text-cyan-700'}`}>
        {isLab ? <Beaker size={13} /> : isSpecialDoctor ? <Stethoscope size={13} /> : <Package size={13} />}
        {formatCurrency(totalAmount, currency)}
      </span>
    );
  };

  const handleMaterialSaved = async (summary: TreatmentCostSummary & { treatmentId: string; patientId?: string | null }) => {
    setMaterialSummaries((current) => {
      const next = { ...current };
      if (summary.itemCount > 0 && summary.totalAmount > 0) {
        next[summary.treatmentId] = {
          auditLogId: summary.auditLogId,
          totalAmount: summary.totalAmount,
          itemCount: summary.itemCount,
          materialTotal: summary.materialTotal,
          materialItemCount: summary.materialItemCount,
          labTotal: summary.labTotal,
          labItemCount: summary.labItemCount,
          specialDoctorTotal: summary.specialDoctorTotal,
          specialDoctorItemCount: summary.specialDoctorItemCount
        };
      } else {
        delete next[summary.treatmentId];
      }
      return next;
    });
    if (onCostsSaved) {
      // Saves only change one patient's ledger, so refresh that patient's rows
      // instead of awaiting a full clinic-wide reload before closing the modal.
      await onCostsSaved(summary.patientId);
    } else {
      await onRefresh();
    }
    await loadMaterialSummaries(paginatedRows);
  };

  const handleRefresh = async () => {
    if (isRefreshing || loading) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } catch (error) {
      console.error('Failed to refresh treatment costs:', error);
      alert(error instanceof Error ? error.message : 'Unable to refresh treatment costs. Please try again.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const materialFilterOptions: Array<{ value: MaterialCostFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'tomorrow', label: 'Tomorrow' },
    { value: 'today', label: 'Today' }
  ];

  const handleDateFromChange = (value: string) => {
    setDateFrom(value);
    if (dateTo && value > dateTo) setDateTo(value);
    setMaterialFilter('custom');
    setCurrentPage(1);
  };

  const handleDateToChange = (value: string) => {
    setDateTo(value);
    if (dateFrom && value < dateFrom) setDateFrom(value);
    setMaterialFilter('custom');
    setCurrentPage(1);
  };

  const handleResetToToday = () => {
    setDateFrom(todayKey);
    setDateTo(todayKey);
    setMaterialFilter('today');
    setCurrentPage(1);
  };

  const handleMaterialFilterChange = (filter: MaterialCostFilter) => {
    setMaterialFilter(filter);
    if (filter === 'all') {
      setDateFrom('');
      setDateTo('');
    } else {
      const selectedDate = filter === 'tomorrow' ? tomorrowKey : todayKey;
      setDateFrom(selectedDate);
      setDateTo(selectedDate);
    }
    setCurrentPage(1);
  };
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm animate-fade-in">
      <div className="border-b border-slate-200 bg-gradient-to-br from-slate-50 via-white to-[var(--hover-50)]/40">
        <div className="flex min-w-0 flex-col gap-4 p-3 sm:p-4 md:p-6 xl:flex-row xl:items-start xl:justify-between xl:gap-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="hidden h-11 w-11 items-center justify-center rounded-2xl border theme-accent-border theme-accent-soft-bg theme-accent-text sm:flex">
              <Package size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-[10px] font-black uppercase tracking-[0.2em] theme-accent-text sm:text-[11px] sm:tracking-[0.24em]">Service Menu</p>
              <h2 className="break-words text-xl font-bold text-slate-900 sm:text-2xl">MLS Costs</h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500 sm:text-sm">
                Track Material, Lab & Special Cost items against completed treatment rows.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <div className="flex max-w-full gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
                  <span className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
                    {statusFilteredRows.length} visible
                  </span>
                  <span className="shrink-0 rounded-full border theme-accent-border theme-accent-soft-bg px-3 py-1 font-semibold theme-accent-text">
                    {statusFilteredRows.length} payments
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={loading || isRefreshing}
                  aria-label={isRefreshing ? 'Refreshing treatment costs' : 'Refresh treatment costs'}
                  className="refresh-action-button inline-flex min-h-9 items-center justify-center gap-2 rounded-xl border px-3 py-1.5 font-bold focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)]"
                >
                  <RotateCw size={14} className={`refresh-action-icon ${isRefreshing ? 'animate-spin' : ''}`} />
                  {isRefreshing ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
          </div>

          <div className="w-full min-w-0 space-y-3 xl:max-w-5xl">
            <div className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
              <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:flex xl:flex-1 xl:flex-wrap xl:items-end">
                  <div className="relative min-w-0 xl:w-52">
                    <input
                      type="text"
                      placeholder="Patient name or ID"
                      value={patientSearchTerm}
                      onChange={(event) => {
                        setPatientSearchTerm(event.target.value);
                        setCurrentPage(1);
                      }}
                      className="w-full min-w-0 rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-800 shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)]"
                    />
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 xl:w-36">
                    <input
                      type="text"
                      placeholder="Doctor"
                      value={doctorSearchTerm}
                      onChange={(event) => {
                        setDoctorSearchTerm(event.target.value);
                        setCurrentPage(1);
                      }}
                      className="w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)]"
                    />
                  </div>
                  <div className="min-w-0 xl:w-40">
                    <input
                      type="text"
                      placeholder="Treatment"
                      value={treatmentSearchTerm}
                      onChange={(event) => {
                        setTreatmentSearchTerm(event.target.value);
                        setCurrentPage(1);
                      }}
                      className="w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)]"
                    />
                  </div>
                  <div className="grid min-w-0 grid-cols-2 gap-2 xl:w-auto">
                    <label className="min-w-0 text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
                      From
                      <input
                        type="date"
                        value={dateFrom}
                        max={dateTo || undefined}
                        onChange={(event) => handleDateFromChange(event.target.value)}
                        className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2.5 py-2.5 text-xs text-slate-800 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 min-[380px]:text-sm xl:w-36 xl:px-3"
                      />
                    </label>
                    <label className="min-w-0 text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
                      To
                      <input
                        type="date"
                        value={dateTo}
                        min={dateFrom || undefined}
                        onChange={(event) => handleDateToChange(event.target.value)}
                        className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2.5 py-2.5 text-xs text-slate-800 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 min-[380px]:text-sm xl:w-36 xl:px-3"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={handleResetToToday}
                      title={isTodayRange ? 'Showing today only' : 'Custom date range selected. Click to reset to today.'}
                      className={`col-span-2 min-h-10 w-full rounded-xl border px-4 py-2.5 text-xs font-bold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)] ${
                        isTodayRange
                          ? 'theme-accent-border theme-accent-soft-bg theme-accent-text hover:bg-blue-100'
                          : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                      }`}
                    >
                      {isTodayRange ? 'Today' : 'Custom'}
                    </button>
                  </div>
                </div>
                <div className="grid w-full grid-cols-3 rounded-xl border border-slate-200 bg-slate-50 p-1 sm:w-auto sm:min-w-[240px] xl:ml-3 xl:flex-none">
                    {materialFilterOptions.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => handleMaterialFilterChange(item.value)}
                        className={`rounded-lg px-2 py-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)] sm:px-3.5 ${
                          materialFilter === item.value
                            ? 'bg-white font-bold theme-accent-text shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 p-12 text-slate-500">
          <Loader2 className="animate-spin text-[var(--hover-600)]" />
          <p className="text-sm font-medium">Loading treatment cost and payment rows...</p>
        </div>
      ) : (
        <>
        <div className="hidden xl:block">
          {isTableScrollable && (
            <div
              id="material-cost-scroll-instructions"
              className="flex items-center justify-between gap-3 border-b border-[var(--hover-100)] bg-[var(--hover-50)] px-4 py-2.5 text-xs font-semibold text-[var(--hover-800)] sm:px-6"
            >
              <span className="flex min-w-0 items-center gap-2">
                <ArrowLeftRight size={16} className="shrink-0 text-[var(--hover-600)]" aria-hidden="true" />
                <span>Scroll sideways to view all columns.</span>
              </span>
              <span className="hidden shrink-0 text-[11px] font-medium text-[var(--hover-700)] 2xl:inline">The Action column stays visible</span>
            </div>
          )}
          <div
            ref={tableScrollRef}
            role="region"
            aria-label="Treatment cost table"
            aria-describedby={isTableScrollable ? 'material-cost-scroll-instructions' : undefined}
            tabIndex={isTableScrollable ? 0 : -1}
            className="overflow-x-auto focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--hover-300)]"
          >
          <table className="min-w-[1560px] w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-6 py-4 text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Date</th>
                <th className="px-6 py-4 text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Patient</th>
                <th className="px-6 py-4 text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Clinician</th>
                <th className="px-6 py-4 text-left text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Clinical Activity</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Patient Balance</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Treatment Amount</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Collected Payment</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Material Cost</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Lab Cost</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Special Doctor Cost</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Total Cost</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Net Receive</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Doctor Earned</th>
                <th className="px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Net Profit</th>
                <th className="sticky right-0 z-20 min-w-[172px] border-l border-slate-200 bg-slate-50 px-6 py-4 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-500 shadow-[-10px_0_16px_-14px_rgba(15,23,42,0.55)]">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {statusFilteredRows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-6 py-12 text-center">
                    <div className="mx-auto max-w-sm rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6">
                      <p className="text-sm font-semibold text-slate-600">No treatment rows found</p>
                      <p className="mt-1 text-xs text-slate-400">Try another date range or clear the search field.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => {
                  const record = row.record;
                  const treatmentAmount = getTreatmentAmount(record);
                  const collectedAmount = row.collectedAmount;
                  const netReceive = getNetReceive(record, collectedAmount);
                  const adjustedDoctorEarned = row.doctorEarned;
                  const netProfit = getNetProfit(record, collectedAmount, adjustedDoctorEarned);
                  return (
                    <tr key={`material-cost-${row.paymentId}`} className="group border-l-4 border-[var(--hover-300)] transition-colors hover:bg-[var(--hover-50)]/30">
                      <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-500 xl:px-6">{record.date}</td>
                      <td className="px-4 py-4 font-bold text-slate-900 xl:px-6">{record.patient_name || 'Unknown'}</td>
                      <td className="px-4 py-4 text-sm text-slate-700 xl:px-6">{formatDoctorName(record.doctor_name)}</td>
                      <td className="max-w-md px-4 py-4 text-sm text-slate-700 xl:px-6">
                        {renderTreatmentDescriptionList(record)}
                        <span className="mt-1 block text-xs font-mono text-gray-500">
                          {record.teeth && record.teeth.length > 0 ? formatTeethWithPosition(record.teeth) : 'General'}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right text-sm xl:px-6">{renderPatientBalance(record.patient_balance)}</td>
                      <td className="px-4 py-4 text-right text-sm font-black text-slate-900 xl:px-6">{formatCurrency(treatmentAmount, currency)}</td>
                      <td className="px-4 py-4 text-right text-sm font-black text-blue-700 xl:px-6">{collectedAmount > 0 ? formatCurrency(collectedAmount, currency) : '-'}</td>
                      <td className="px-4 py-4 text-right text-sm font-bold xl:px-6">{renderTypedCost(record, 'material')}</td>
                      <td className="px-4 py-4 text-right text-sm font-bold xl:px-6">{renderTypedCost(record, 'lab')}</td>
                      <td className="px-4 py-4 text-right text-sm font-bold xl:px-6">{renderTypedCost(record, 'special_doctor')}</td>
                      <td className="px-4 py-4 text-right text-sm font-black text-slate-800 xl:px-6">{getMaterialTotal(record) > 0 ? formatCurrency(getMaterialTotal(record), currency) : '-'}</td>
                      <td className="px-4 py-4 text-right text-sm font-black text-teal-700 xl:px-6">{collectedAmount > 0 ? formatCurrency(netReceive, currency) : '-'}</td>
                      <td className="px-4 py-4 text-right text-sm font-bold text-emerald-700 xl:px-6">{adjustedDoctorEarned > 0 ? formatCurrency(adjustedDoctorEarned, currency) : '-'}</td>
                      <td className={`px-4 py-4 text-right text-sm font-black xl:px-6 ${netProfit >= 0 ? 'text-slate-900' : 'text-red-600'}`}>{formatCurrency(netProfit, currency)}</td>
                      <td className="sticky right-0 z-10 min-w-[172px] border-l border-slate-100 bg-white px-4 py-4 text-right shadow-[-10px_0_16px_-14px_rgba(15,23,42,0.55)] transition-colors group-hover:bg-[var(--hover-50)] xl:px-6">
                        {canManageMaterials ? (
                          <button
                            type="button"
                            onClick={() => setEditingRecord(record)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--hover-200)] bg-[var(--hover-50)] px-3 py-1.5 text-xs font-bold text-[var(--hover-700)] hover:bg-[var(--hover-100)]"
                          >
                            <Package size={13} />
                            <Plus size={12} />
                            MLS Costs
                          </button>
                        ) : (
                          <span className="text-xs font-semibold text-slate-400">No access</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        </div>
        <div className="space-y-3 bg-slate-50/70 p-3 sm:p-4 xl:hidden">
          {statusFilteredRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center">
              <p className="text-sm font-semibold text-slate-600">No treatment rows found</p>
              <p className="mt-1 text-xs text-slate-400">Try another date range or clear the search field.</p>
            </div>
          ) : (
            paginatedRows.map((row) => {
              const record = row.record;
              const treatmentAmount = getTreatmentAmount(record);
              const collectedAmount = row.collectedAmount;
              const adjustedDoctorEarned = row.doctorEarned;
              const netProfit = getNetProfit(record, collectedAmount, adjustedDoctorEarned);
              const totalCost = getMaterialTotal(record);
              const netReceive = getNetReceive(record, collectedAmount);
              return (
                <article key={`material-cost-card-${row.paymentId}`} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-l-4 border-[var(--hover-300)] p-3 sm:p-4">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-base font-bold text-slate-900">{record.patient_name || 'Unknown'}</p>
                        <p className="mt-1 break-words text-xs text-slate-500">{record.date} · {formatDoctorName(record.doctor_name)}</p>
                      </div>
                      <div className={`shrink-0 rounded-lg px-2.5 py-1 text-right ${netProfit >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                        <p className="text-[10px] font-bold uppercase tracking-wide">Net profit</p>
                        <p className="mt-0.5 text-sm font-black">{formatCurrency(netProfit, currency)}</p>
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl bg-slate-50 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Clinical activity</p>
                      <div className="mt-1 break-words text-sm text-slate-800">{renderTreatmentDescriptionList(record)}</div>
                      <p className="mt-1 break-words font-mono text-xs text-slate-500">
                        {record.teeth && record.teeth.length > 0 ? formatTeethWithPosition(record.teeth) : 'General'}
                      </p>
                    </div>

                    <dl className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
                      <div className="min-w-0 rounded-xl border border-slate-100 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Patient balance</dt>
                        <dd className="mt-1 min-w-0 text-sm font-bold">{renderPatientBalance(record.patient_balance)}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-slate-100 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Treatment amount</dt>
                        <dd className="mt-1 break-words text-sm font-black text-slate-900">{formatCurrency(treatmentAmount, currency)}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-blue-100 bg-blue-50 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-blue-600">Collected payment</dt>
                        <dd className="mt-1 break-words text-sm font-black text-blue-700">{collectedAmount > 0 ? formatCurrency(collectedAmount, currency) : '-'}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-cyan-100 bg-cyan-50 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-cyan-700">Material cost</dt>
                        <dd className="mt-1 text-sm font-bold">{renderTypedCost(record, 'material')}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-violet-100 bg-violet-50 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-violet-700">Lab cost</dt>
                        <dd className="mt-1 text-sm font-bold">{renderTypedCost(record, 'lab')}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-amber-100 bg-amber-50 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-amber-700">Special doctor cost</dt>
                        <dd className="mt-1 text-sm font-bold">{renderTypedCost(record, 'special_doctor')}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-100 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-600">Total cost</dt>
                        <dd className="mt-1 break-words text-sm font-black text-slate-800">{totalCost > 0 ? formatCurrency(totalCost, currency) : '-'}</dd>
                      </div>
                      <div className="min-w-0 rounded-xl border border-teal-100 bg-teal-50 p-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-teal-700">Net receive</dt>
                        <dd className="mt-1 break-words text-sm font-black text-teal-700">{collectedAmount > 0 ? formatCurrency(netReceive, currency) : '-'}</dd>
                      </div>
                      <div className="col-span-2 min-w-0 rounded-xl border border-emerald-100 bg-emerald-50 p-3 sm:col-span-3">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Doctor earned</dt>
                        <dd className="mt-1 break-words text-sm font-black text-emerald-700">{adjustedDoctorEarned > 0 ? formatCurrency(adjustedDoctorEarned, currency) : '-'}</dd>
                      </div>
                    </dl>

                    <div className="mt-3">
                      {canManageMaterials ? (
                        <button
                          type="button"
                          onClick={() => setEditingRecord(record)}
                          className="flex min-h-10 w-full items-center justify-center gap-1 rounded-xl border border-[var(--hover-200)] bg-[var(--hover-50)] px-3 py-2 text-sm font-bold text-[var(--hover-700)] transition-colors hover:bg-[var(--hover-100)] focus:outline-none focus:ring-2 focus:ring-[var(--hover-300)]"
                        >
                          <Package size={15} />
                          <Plus size={13} />
                          MLS Costs
                        </button>
                      ) : (
                        <p className="rounded-xl bg-slate-50 px-3 py-2 text-center text-xs font-semibold text-slate-400">No access to manage costs</p>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
        </>
      )}

      {!loading && statusFilteredRows.length > 0 && (
        <Pagination
          totalItems={statusFilteredRows.length}
          itemsPerPage={itemsPerPage}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          showAll={showAll}
          onToggleShowAll={() => setShowAll(!showAll)}
        />
      )}

      <MaterialCostModal
        isOpen={!!editingRecord}
        record={editingRecord}
        currency={currency}
        onClose={() => setEditingRecord(null)}
        onSaved={handleMaterialSaved}
      />
    </div>
  );
};

export default MaterialCostView;
