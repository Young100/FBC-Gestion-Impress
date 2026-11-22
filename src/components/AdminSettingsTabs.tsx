import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserPlus,
} from 'lucide-react';
import { getServiceImageSrc, SERVICE_IMAGE_OPTIONS } from '../data/defaults';
import {
  createStaffAccess,
  deleteServiceServer,
  deleteStaffAccess,
  fetchAdminClientAccounts,
  fetchServerAuditLogsByRange,
  listStaffAccess,
  resetClientAccountPasswordServer,
  saveClientNotesServer,
  saveServiceServer,
  saveShopSettingsServer,
  toggleClientAccountActiveServer,
  updateGoogleStaffStatus,
  updateStaffAccess,
} from '../lib/adminApi';
import {
  adminDeleteService,
  adminSaveClientNotes,
  adminSaveService,
  adminSaveShopSettings,
  fetchAuditLogsByRange,
} from '../lib/firestoreApi';
import { formatFcfa, isApparelSlug } from '../lib/pricing';
import { startResumableUpload } from '../lib/uploadClient';
import {
  ORDER_STATUS_META,
  type AdminClientAccountSummary,
  type AdminUser,
  type AuditLog,
  type ClientProfile,
  type Order,
  type Payment,
  type PricingMode,
  type PrintService,
  type ServiceSlug,
  type ShopSettings,
  type StaffCredentialPublic,
} from '../types/fbc';

interface AdminSettingsTabsProps {
  activeTab: 'services' | 'clients' | 'stats' | 'settings';
  staffUser: AdminUser;
  services: PrintService[];
  orders: Order[];
  payments: Payment[];
  clients: ClientProfile[];
  auditLogs: AuditLog[];
  settings: ShopSettings;
  onReprintOrder: (order: Order) => void;
  onRefreshData?: () => Promise<void> | void;
}

export const AdminSettingsTabs: React.FC<AdminSettingsTabsProps> = ({
  activeTab,
  staffUser,
  services,
  orders,
  payments,
  clients,
  auditLogs,
  settings,
  onReprintOrder,
  onRefreshData,
}) => {
  const isAdmin = staffUser.role === 'admin';
  const useServerApi = staffUser.authMethod === 'credentials';
  const safeServices = useMemo(() => (Array.isArray(services) ? services : []), [services]);
  const safeOrders = useMemo(() => (Array.isArray(orders) ? orders : []), [orders]);
  const safePayments = useMemo(() => (Array.isArray(payments) ? payments : []), [payments]);
  const safeClients = useMemo(() => (Array.isArray(clients) ? clients : []), [clients]);
  const safeAuditLogs = useMemo(() => (Array.isArray(auditLogs) ? auditLogs : []), [auditLogs]);

  // --- Services state ---
  const [editingService, setEditingService] = useState<PrintService | null>(null);
  const [editImageUploading, setEditImageUploading] = useState(false);
  const [editImageError, setEditImageError] = useState<string | null>(null);
  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceSlug, setNewServiceSlug] = useState<ServiceSlug>('grand_format');
  const [newServicePrice, setNewServicePrice] = useState(5000);
  const [newServiceImageKey, setNewServiceImageKey] = useState('hero');
  const [newServiceImageUrl, setNewServiceImageUrl] = useState('');
  const [newImageUploading, setNewImageUploading] = useState(false);
  const [newImageError, setNewImageError] = useState<string | null>(null);

  const handleServiceImageUpload = async (
    file: File,
    target: 'edit' | 'new'
  ) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif'];
    const ext = `.${file.name.split('.').pop()?.toLowerCase() || ''}`;
    const setErr = target === 'edit' ? setEditImageError : setNewImageError;
    const setUploading = target === 'edit' ? setEditImageUploading : setNewImageUploading;

    setErr(null);
    if (!allowed.includes(ext)) {
      setErr('Format d’image non supporté. Utilisez JPG, PNG, WebP ou SVG.');
      return;
    }
    if (file.size <= 0 || file.size > 15 * 1024 * 1024) {
      setErr('L’image doit faire moins de 15 Mo.');
      return;
    }

    setUploading(true);
    try {
      const { promise } = startResumableUpload(
        file,
        {
          itemId: `service_img_${Date.now()}`,
          slotKey: 'service_thumbnail',
          slotLabel: 'Image prestation',
          purpose: 'service_image',
          authMode: 'staff',
        },
        () => {}
      );
      const meta = await promise;
      const previewUrl = `/api/files/${meta.fileId}/preview`;
      if (target === 'edit') {
        setEditingService((prev) => (prev ? { ...prev, imageUrl: previewUrl } : prev));
      } else {
        setNewServiceImageUrl(previewUrl);
      }
    } catch (err) {
      setErr(
        err instanceof Error ? err.message : 'Échec de l’importation de l’image.'
      );
    } finally {
      setUploading(false);
    }
  };

  // --- Clients & Client Accounts state ---
  const [clientSearch, setClientSearch] = useState('');
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [clientAccounts, setClientAccounts] = useState<AdminClientAccountSummary[]>([]);
  const [clientAccountsLoading, setClientAccountsLoading] = useState(false);
  const [clientAccountsError, setClientAccountsError] = useState<string | null>(null);
  const [tempPasswordsMap, setTempPasswordsMap] = useState<Record<string, string>>({});
  const [clientAccountBusyId, setClientAccountBusyId] = useState<string | null>(null);
  const [copiedAccountPwdId, setCopiedAccountPwdId] = useState<string | null>(null);

  const loadClientAccounts = useCallback(async () => {
    setClientAccountsLoading(true);
    setClientAccountsError(null);
    try {
      const list = await fetchAdminClientAccounts();
      setClientAccounts(list);
    } catch (err) {
      setClientAccountsError(
        err instanceof Error
          ? err.message
          : 'Impossible de charger les comptes clients inscrits.'
      );
    } finally {
      setClientAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'clients') {
      void loadClientAccounts();
    }
  }, [activeTab, loadClientAccounts]);

  // --- Settings & Server-Side Staff Access state ---
  const [settingsDraft, setSettingsDraft] = useState<ShopSettings>(settings);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [staffCredentials, setStaffCredentials] = useState<StaffCredentialPublic[]>([]);
  const [googleStaffList, setGoogleStaffList] = useState<AdminUser[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [newAccessName, setNewAccessName] = useState('');
  const [newAccessRole, setNewAccessRole] = useState<'operator' | 'admin'>('operator');
  const [newAccessPassword, setNewAccessPassword] = useState('');
  const [showNewAccessPassword, setShowNewAccessPassword] = useState(false);
  const [creatingAccess, setCreatingAccess] = useState(false);
  const [createdCredentialNotice, setCreatedCredentialNotice] =
    useState<StaffCredentialPublic | null>(null);
  const [copiedAccessId, setCopiedAccessId] = useState<string | null>(null);
  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPasswordDraft, setResetPasswordDraft] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // --- Audit log daily/monthly explorer state ---
  const formatLocalDay = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const formatLocalMonth = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  };
  const todayDayStr = formatLocalDay(new Date());
  const currentMonthStr = formatLocalMonth(new Date());

  const [auditViewMode, setAuditViewMode] = useState<'day' | 'month'>('day');
  const [auditSelectedDay, setAuditSelectedDay] = useState<string>(todayDayStr);
  const [auditSelectedMonth, setAuditSelectedMonth] = useState<string>(currentMonthStr);
  const [auditSearch, setAuditSearch] = useState('');
  const [archivedAuditLogs, setArchivedAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditReloadTick, setAuditReloadTick] = useState(0);

  const parseAuditCreatedAt = (val: unknown): Date | null => {
    if (!val) return null;
    if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
    if (typeof val === 'string') {
      const parsed = new Date(val);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof val === 'object') {
      const maybeTs = val as { toDate?: () => Date; seconds?: number };
      if (typeof maybeTs.toDate === 'function') {
        const d = maybeTs.toDate();
        return Number.isNaN(d.getTime()) ? null : d;
      }
      if (typeof maybeTs.seconds === 'number') {
        return new Date(maybeTs.seconds * 1000);
      }
    }
    return null;
  };

  const shiftAuditDay = (dayStr: string, deltaDays: number): string => {
    const [y, m, d] = dayStr.split('-').map(Number);
    if (!y || !m || !d) return todayDayStr;
    return formatLocalDay(new Date(y, m - 1, d + deltaDays));
  };

  const shiftAuditMonth = (monthStr: string, deltaMonths: number): string => {
    const [y, m] = monthStr.split('-').map(Number);
    if (!y || !m) return currentMonthStr;
    return formatLocalMonth(new Date(y, m - 1 + deltaMonths, 1));
  };

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

  const safeStaffCredentials = Array.isArray(staffCredentials) ? staffCredentials : [];
  const safeGoogleStaffList = Array.isArray(googleStaffList) ? googleStaffList : [];
  const safeArchivedAuditLogs = Array.isArray(archivedAuditLogs) ? archivedAuditLogs : [];

  const loadStaffAccess = useCallback(async () => {
    setStaffLoading(true);
    setStaffError(null);
    try {
      const res = await listStaffAccess();
      setStaffCredentials(Array.isArray(res?.credentials) ? res.credentials : []);
      setGoogleStaffList(Array.isArray(res?.googleUsers) ? res.googleUsers : []);
    } catch (err) {
      setStaffError(
        err instanceof Error
          ? err.message
          : 'Impossible de charger la liste des accès collaborateurs.'
      );
    } finally {
      setStaffLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'settings' && isAdmin) {
      loadStaffAccess();
    }
  }, [activeTab, isAdmin, loadStaffAccess]);

  const copyAccessId = async (accessId: string) => {
    try {
      await navigator.clipboard.writeText(accessId);
      setCopiedAccessId(accessId);
      setTimeout(() => setCopiedAccessId(null), 2000);
    } catch {
      // Clipboard blocked in some contexts
    }
  };

  // Fetch historical audit logs whenever viewing a previous day or a full month
  useEffect(() => {
    if (activeTab !== 'settings' || !isAdmin) return;
    if (auditViewMode === 'day' && auditSelectedDay === todayDayStr && auditReloadTick === 0) {
      setAuditError(null);
      setAuditLoading(false);
      return;
    }

    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);

    let start: Date;
    let end: Date;
    let limitCount = 500;

    if (auditViewMode === 'day') {
      const [y, m, d] = auditSelectedDay.split('-').map(Number);
      start = new Date(y, m - 1, d, 0, 0, 0, 0);
      end = new Date(y, m - 1, d, 23, 59, 59, 999);
    } else {
      const [y, m] = auditSelectedMonth.split('-').map(Number);
      start = new Date(y, m - 1, 1, 0, 0, 0, 0);
      end = new Date(y, m, 0, 23, 59, 59, 999);
      limitCount = 1000;
    }

    const fetcher = useServerApi
      ? fetchServerAuditLogsByRange(start, end, limitCount)
      : fetchAuditLogsByRange(start, end, limitCount);

    fetcher
      .then((logs) => {
        if (!cancelled) {
          setArchivedAuditLogs(Array.isArray(logs) ? logs : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuditError('Impossible de charger les journaux pour cette période.');
        }
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    isAdmin,
    useServerApi,
    auditViewMode,
    auditSelectedDay,
    auditSelectedMonth,
    todayDayStr,
    auditReloadTick,
  ]);

  const displayedAuditLogs = useMemo(() => {
    const isLiveToday =
      auditViewMode === 'day' && auditSelectedDay === todayDayStr && auditReloadTick === 0;
    const source = isLiveToday
      ? safeAuditLogs.filter((log) => {
          const dt = parseAuditCreatedAt(log.createdAt);
          if (!dt) return true; // optimistic serverTimestamp pending
          return formatLocalDay(dt) === todayDayStr;
        })
      : safeArchivedAuditLogs;

    const q = auditSearch.trim().toLowerCase();
    if (!q) return source;
    return source.filter((log) =>
      [log.action, log.targetId, log.targetType, log.actorEmail, log.details || '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [
    auditViewMode,
    auditSelectedDay,
    todayDayStr,
    auditReloadTick,
    safeAuditLogs,
    safeArchivedAuditLogs,
    auditSearch,
  ]);

  const monthlyGroupedAuditLogs = useMemo(() => {
    if (auditViewMode !== 'month') return [];
    const groups = new Map<string, AuditLog[]>();
    for (const log of displayedAuditLogs) {
      const dt = parseAuditCreatedAt(log.createdAt) || new Date();
      const dayKey = formatLocalDay(dt);
      const list = groups.get(dayKey) || [];
      list.push(log);
      groups.set(dayKey, list);
    }
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [auditViewMode, displayedAuditLogs]);

  // Stats computation
  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byService: Record<string, { count: number; revenue: number }> = {};
    const byOperator: Record<string, number> = {};
    let totalTurnaroundHours = 0;
    let deliveredCount = 0;

    for (const o of safeOrders) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      for (const it of Array.isArray(o.items) ? o.items : []) {
        if (!byService[it.serviceName]) {
          byService[it.serviceName] = { count: 0, revenue: 0 };
        }
        byService[it.serviceName].count += 1;
        byService[it.serviceName].revenue += it.subtotal;
      }
      const history = Array.isArray(o.statusHistory) ? o.statusHistory : [];
      if (o.status === 'livree' && history.length >= 2) {
        const first = new Date(history[0].timestamp).getTime();
        const last = new Date(history[history.length - 1].timestamp).getTime();
        if (!Number.isNaN(first) && !Number.isNaN(last) && last > first) {
          totalTurnaroundHours += (last - first) / (1000 * 60 * 60);
          deliveredCount += 1;
        }
      }
    }

    for (const p of safePayments) {
      if (p.status === 'valide') {
        byOperator[p.methodName] = (byOperator[p.methodName] || 0) + p.declaredAmount;
      }
    }

    const avgHours = deliveredCount > 0 ? Math.round(totalTurnaroundHours / deliveredCount) : 0;
    return { byStatus, byService, byOperator, avgHours };
  }, [safeOrders, safePayments]);

  const exportCsv = (type: 'orders' | 'payments') => {
    const bom = '\uFEFF';
    let csv = '';
    if (type === 'orders') {
      csv =
        'Numero;Client;Telephone;Statut;StatutPaiement;TotalFCFA;PayeFCFA;Urgent;Prestations\n' +
        safeOrders
          .map(
            (o) =>
              `"${o.orderNumber}";"${o.customerName}";"${o.customerPhone}";"${ORDER_STATUS_META[o.status].label}";"${o.paymentStatus}";${o.totalAmount};${o.paidAmount || 0};${o.urgent ? 'Oui' : 'Non'};"${(Array.isArray(o.items) ? o.items : []).map((i) => i.serviceName).join(', ')}"`
          )
          .join('\n');
    } else {
      csv =
        'ID;Commande;Client;Operateur;TelephoneDepot;Reference;MontantFCFA;Statut;Validateur\n' +
        safePayments
          .map(
            (p) =>
              `"${p.paymentId}";"${p.orderNumber}";"${p.customerName}";"${p.methodName}";"${p.depositPhone}";"${p.transactionRef || ''}";${p.declaredAmount};"${p.status}";"${p.validatedByEmail || ''}"`
          )
          .join('\n');
    }

    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fbc_print_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (activeTab === 'services' && isAdmin) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
          <h2 className="font-display text-xl text-[#26547C]">
            Prestations et grilles tarifaires
          </h2>

          <div className="divide-y divide-slate-100">
            {safeServices.map((srv) => (
              <div
                key={srv.id}
                className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <img
                    src={getServiceImageSrc(srv)}
                    alt={srv.name}
                    referrerPolicy="no-referrer"
                    className="w-16 h-12 rounded-xl object-cover bg-[#EDF2F4] border border-slate-200 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[#26547C] truncate">{srv.name}</span>
                      {!srv.active && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 shrink-0">
                          Désactivée
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {srv.description} · Tarif de base :{' '}
                      <strong className="tabular-nums">{formatFcfa(srv.basePrice)}</strong> ·{' '}
                      {srv.recommendedDpi} DPI
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setEditImageError(null);
                      setEditingService({ ...srv });
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold min-h-[40px] hover:bg-[#119DA4]/15"
                  >
                    <ImageIcon className="w-3.5 h-3.5 text-[#119DA4]" />
                    Modifier / Image
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const updated = { ...srv, active: !srv.active };
                      if (useServerApi) {
                        await saveServiceServer(updated);
                        await onRefreshData?.();
                      } else {
                        await adminSaveService(updated, staffUser.email);
                      }
                    }}
                    className="px-4 py-2 rounded-full border border-slate-200 text-xs font-semibold min-h-[40px]"
                  >
                    {srv.active ? 'Désactiver' : 'Activer'}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (useServerApi) {
                        await deleteServiceServer(srv.id);
                        await onRefreshData?.();
                      } else {
                        await adminDeleteService(srv.id, staffUser.email);
                      }
                    }}
                    className="p-2 text-slate-400 hover:text-[#EF233C]"
                    aria-label="Supprimer prestation"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Edit Service Modal Inline */}
        {editingService && (
          <div className="bg-white rounded-3xl p-6 border-2 border-[#119DA4] shadow-sm space-y-5">
            <h3 className="font-bold text-lg text-[#26547C]">
              Éditer : {editingService.name}
            </h3>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Nom affiché
                </label>
                <input
                  type="text"
                  value={editingService.name}
                  onChange={(e) =>
                    setEditingService({ ...editingService, name: e.target.value })
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Tarif de base (FCFA)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editingService.basePrice}
                  onChange={(e) =>
                    setEditingService({
                      ...editingService,
                      basePrice: Number(e.target.value),
                    })
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  DPI recommandé
                </label>
                <input
                  type="number"
                  min={50}
                  value={editingService.recommendedDpi}
                  onChange={(e) =>
                    setEditingService({
                      ...editingService,
                      recommendedDpi: Number(e.target.value),
                    })
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Description
              </label>
              <input
                type="text"
                value={editingService.description}
                onChange={(e) =>
                  setEditingService({ ...editingService, description: e.target.value })
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
              />
            </div>

            {isApparelSlug(editingService.slug) && (
              <div className="grid sm:grid-cols-3 gap-4 rounded-2xl bg-[#EDF2F4]/60 p-4 border border-slate-200/80">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Supplément DTF (FCFA)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={editingService.config?.apparelTechPrices?.dtf ?? 1000}
                    onChange={(e) =>
                      setEditingService({
                        ...editingService,
                        config: {
                          ...editingService.config,
                          apparelTechPrices: {
                            dtf: Math.max(0, Number(e.target.value)),
                            sublimation:
                              editingService.config?.apparelTechPrices?.sublimation ?? 750,
                          },
                        },
                      })
                    }
                    className="w-full px-3.5 py-2 rounded-xl bg-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Supplément Sublimation (FCFA)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={editingService.config?.apparelTechPrices?.sublimation ?? 750}
                    onChange={(e) =>
                      setEditingService({
                        ...editingService,
                        config: {
                          ...editingService.config,
                          apparelTechPrices: {
                            dtf: editingService.config?.apparelTechPrices?.dtf ?? 1000,
                            sublimation: Math.max(0, Number(e.target.value)),
                          },
                        },
                      })
                    }
                    className="w-full px-3.5 py-2 rounded-xl bg-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Prix par emplacement (FCFA)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={editingService.config?.apparelPlacementPrice ?? 1000}
                    onChange={(e) =>
                      setEditingService({
                        ...editingService,
                        config: {
                          ...editingService.config,
                          apparelPlacementPrice: Math.max(0, Number(e.target.value)),
                        },
                      })
                    }
                    className="w-full px-3.5 py-2 rounded-xl bg-white text-sm"
                  />
                </div>
              </div>
            )}

            {/* Service Image Editor */}
            <div className="rounded-2xl bg-[#EDF2F4]/70 p-4 space-y-4 border border-slate-200/80">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#26547C] flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4 text-[#119DA4]" />
                  Image de la prestation (aperçu client)
                </span>
                {editingService.imageUrl && (
                  <button
                    type="button"
                    onClick={() =>
                      setEditingService({ ...editingService, imageUrl: '' })
                    }
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#EF233C] hover:underline"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Revenir au visuel par défaut
                  </button>
                )}
              </div>

              <div className="flex flex-col sm:flex-row items-start gap-4">
                <img
                  src={getServiceImageSrc(editingService)}
                  alt={editingService.name}
                  referrerPolicy="no-referrer"
                  className="w-36 h-24 rounded-2xl object-cover bg-white border border-slate-200 shrink-0"
                />
                <div className="flex-1 w-full space-y-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <label className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#119DA4] text-white text-xs font-semibold cursor-pointer hover:bg-[#0e848a] min-h-[40px]">
                      {editImageUploading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <UploadCloud className="w-4 h-4" />
                      )}
                      {editImageUploading ? 'Import en cours...' : 'Importer une image'}
                      <input
                        type="file"
                        accept=".jpg,.jpeg,.png,.webp,.svg,.gif"
                        className="sr-only"
                        disabled={editImageUploading}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleServiceImageUpload(f, 'edit');
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <span className="text-[11px] text-slate-500">
                      JPG, PNG, WebP ou SVG · ou saisissez une URL ci-dessous
                    </span>
                  </div>

                  <input
                    type="text"
                    value={editingService.imageUrl || ''}
                    onChange={(e) =>
                      setEditingService({
                        ...editingService,
                        imageUrl: e.target.value,
                      })
                    }
                    placeholder="URL personnalisée (optionnel, ex : https://... ou /api/files/...)"
                    maxLength={500}
                    className="w-full px-3.5 py-2 rounded-xl bg-white border border-slate-200 text-xs"
                  />

                  {editImageError && (
                    <p className="text-xs font-medium text-[#EF233C]">{editImageError}</p>
                  )}

                  <div>
                    <span className="block text-[11px] font-semibold text-slate-600 mb-1.5">
                      Ou choisir un visuel de la galerie FBC Print :
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {SERVICE_IMAGE_OPTIONS.map((opt) => {
                        const isSelected =
                          !editingService.imageUrl && editingService.imageKey === opt.key;
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() =>
                              setEditingService({
                                ...editingService,
                                imageKey: opt.key,
                                imageUrl: '',
                              })
                            }
                            className={`rounded-xl overflow-hidden border-2 text-left transition-all bg-white ${
                              isSelected
                                ? 'border-[#26547C] ring-2 ring-[#119DA4]/30'
                                : 'border-slate-200 hover:border-[#119DA4]/60'
                            }`}
                          >
                            <img
                              src={opt.src}
                              alt={opt.label}
                              className="w-full h-12 object-cover"
                            />
                            <div className="px-1.5 py-1 text-[10px] font-semibold text-[#26547C] truncate">
                              {opt.label}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                disabled={editImageUploading}
                onClick={async () => {
                  const trimmedUrl = (editingService.imageUrl || '').trim();
                  const payload: PrintService = {
                    ...editingService,
                    imageUrl: trimmedUrl,
                  };
                  if (useServerApi) {
                    await saveServiceServer(payload);
                    await onRefreshData?.();
                  } else {
                    await adminSaveService(payload, staffUser.email);
                  }
                  setEditingService(null);
                }}
                className="px-6 py-2.5 rounded-full bg-[#26547C] text-white text-sm font-semibold min-h-[44px] disabled:opacity-50"
              >
                Enregistrer
              </button>
              <button
                type="button"
                onClick={() => setEditingService(null)}
                className="px-5 py-2.5 rounded-full border border-slate-300 text-sm"
              >
                Annuler
              </button>
            </div>
          </div>
        )}

        {/* Add New Service */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
          <h3 className="font-bold text-base text-[#26547C]">
            Ajouter une nouvelle prestation
          </h3>
          <div className="grid sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Nom</label>
              <input
                type="text"
                value={newServiceName}
                onChange={(e) => setNewServiceName(e.target.value)}
                placeholder="Ex : Bâche micro-perforée"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Gabarit champs</label>
              <select
                value={newServiceSlug}
                onChange={(e) => setNewServiceSlug(e.target.value as ServiceSlug)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              >
                <option value="grand_format">Grand format (m²)</option>
                <option value="format_standard">Format standard</option>
                <option value="portrait">Portrait</option>
                <option value="kakemono">Kakemono</option>
                <option value="carte_visite">Carte de visite</option>
                <option value="catalogue">Catalogue</option>
                <option value="polo">Polo personnalisé</option>
                <option value="tshirt">T-shirt personnalisé</option>
                <option value="casquette">Casquette personnalisée</option>
                <option value="maillot">Maillot</option>
                <option value="etiquettes">Étiquettes</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Prix base (FCFA)</label>
              <input
                type="number"
                min={0}
                value={newServicePrice}
                onChange={(e) => setNewServicePrice(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              />
            </div>
            <button
              type="button"
              disabled={newImageUploading}
              onClick={async () => {
                if (!newServiceName.trim()) return;
                const modeMap: Record<ServiceSlug, PricingMode> = {
                  grand_format: 'per_sqm',
                  portrait: 'per_sqm',
                  format_standard: 'per_format',
                  kakemono: 'per_unit_tier',
                  carte_visite: 'per_unit_tier',
                  etiquettes: 'per_unit_tier',
                  catalogue: 'per_page_copy',
                  polo: 'per_apparel',
                  tshirt: 'per_apparel',
                  casquette: 'per_apparel',
                  habits: 'per_apparel',
                  maillot: 'per_jersey',
                };
                const defaultConfig = isApparelSlug(newServiceSlug)
                  ? {
                      apparelTechPrices: { dtf: 1000, sublimation: 750 },
                      apparelPlacementPrice: 1000,
                    }
                  : {};
                const newSrv: PrintService = {
                  id: `srv_${Date.now()}`,
                  slug: newServiceSlug,
                  name: newServiceName.trim(),
                  description: 'Prestation sur mesure FBC Print.',
                  imageKey: newServiceImageKey,
                  imageUrl: newServiceImageUrl.trim(),
                  pricingMode: modeMap[newServiceSlug],
                  basePrice: newServicePrice,
                  recommendedDpi: 300,
                  active: true,
                  sortOrder: safeServices.length + 1,
                  config: defaultConfig,
                };
                if (useServerApi) {
                  await saveServiceServer(newSrv);
                  await onRefreshData?.();
                } else {
                  await adminSaveService(newSrv, staffUser.email);
                }
                setNewServiceName('');
                setNewServiceImageUrl('');
                setNewServiceImageKey('hero');
              }}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[#119DA4] text-white text-sm font-semibold min-h-[44px] disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              Ajouter
            </button>
          </div>

          {/* Image Picker for New Service */}
          <div className="rounded-2xl bg-[#EDF2F4]/60 p-4 border border-slate-200/80 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[#26547C]">
                Image de la nouvelle prestation
              </span>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-[#26547C] text-xs font-semibold cursor-pointer hover:border-[#119DA4]">
                  {newImageUploading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#119DA4]" />
                  ) : (
                    <UploadCloud className="w-3.5 h-3.5 text-[#119DA4]" />
                  )}
                  {newImageUploading ? 'Import...' : 'Importer une image'}
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.svg,.gif"
                    className="sr-only"
                    disabled={newImageUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleServiceImageUpload(f, 'new');
                      e.target.value = '';
                    }}
                  />
                </label>
                {newServiceImageUrl && (
                  <button
                    type="button"
                    onClick={() => setNewServiceImageUrl('')}
                    className="text-xs font-semibold text-[#EF233C] hover:underline"
                  >
                    Retirer
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start gap-3">
              <img
                src={getServiceImageSrc({
                  imageKey: newServiceImageKey,
                  imageUrl: newServiceImageUrl,
                })}
                alt="Aperçu nouvelle prestation"
                referrerPolicy="no-referrer"
                className="w-24 h-16 rounded-xl object-cover bg-white border border-slate-200 shrink-0"
              />
              <div className="flex-1 w-full space-y-2">
                <input
                  type="text"
                  value={newServiceImageUrl}
                  onChange={(e) => setNewServiceImageUrl(e.target.value)}
                  placeholder="Ou coller une URL d’image (optionnel)"
                  maxLength={500}
                  className="w-full px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs"
                />
                {newImageError && (
                  <p className="text-xs font-medium text-[#EF233C]">{newImageError}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {SERVICE_IMAGE_OPTIONS.map((opt) => {
                    const selected = !newServiceImageUrl && newServiceImageKey === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setNewServiceImageKey(opt.key);
                          setNewServiceImageUrl('');
                        }}
                        className={`px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                          selected
                            ? 'bg-[#26547C] text-white border-[#26547C]'
                            : 'bg-white text-[#26547C] border-slate-200 hover:border-[#119DA4]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === 'clients') {
    const searchLower = clientSearch.toLowerCase();
    const filteredClients = safeClients.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(searchLower) ||
        (c.phone || '').includes(clientSearch)
    );
    const filteredAccounts = clientAccounts.filter(
      (a) =>
        a.username.toLowerCase().includes(searchLower) ||
        a.fullName.toLowerCase().includes(searchLower) ||
        a.phone.includes(clientSearch)
    );

    return (
      <div className="space-y-6">
        {/* Registered Client Accounts */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl text-[#26547C]">
                Comptes clients inscrits ({clientAccounts.length})
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Chaque client consulte uniquement ses propres commandes après connexion sécurisée.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                placeholder="Rechercher @pseudo, nom ou téléphone..."
                className="px-4 py-2 rounded-full bg-[#EDF2F4] text-sm min-w-[230px]"
              />
              <button
                type="button"
                onClick={() => void loadClientAccounts()}
                disabled={clientAccountsLoading}
                className="p-2.5 rounded-full bg-[#EDF2F4] text-[#26547C] hover:bg-[#119DA4]/15 min-h-[40px] min-w-[40px] flex items-center justify-center"
                title="Actualiser les comptes"
                aria-label="Actualiser les comptes"
              >
                <RefreshCw className={`w-4 h-4 ${clientAccountsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {clientAccountsError && (
            <p className="text-xs font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-2.5 rounded-2xl">
              {clientAccountsError}
            </p>
          )}

          {clientAccountsLoading && clientAccounts.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin text-[#119DA4] mx-auto mb-1" />
              Chargement des comptes clients...
            </div>
          ) : filteredAccounts.length === 0 ? (
            <p className="text-sm text-slate-500 py-5 text-center">
              Aucun compte client inscrit ne correspond à la recherche.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredAccounts.map((acc) => {
                const tempPwd = tempPasswordsMap[acc.accountId];
                const busy = clientAccountBusyId === acc.accountId;
                return (
                  <div
                    key={acc.accountId}
                    className="py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-[#26547C]">
                          {acc.fullName}
                        </span>
                        <span className="text-xs font-mono font-semibold text-[#119DA4] bg-[#119DA4]/10 px-2.5 py-0.5 rounded-full">
                          @{acc.username}
                        </span>
                        <span
                          className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                            acc.active
                              ? 'bg-[#2E9E6B]/15 text-[#237A52]'
                              : 'bg-[#EF233C]/10 text-[#EF233C]'
                          }`}
                        >
                          {acc.active ? 'Actif' : 'Désactivé'}
                        </span>
                        {acc.mustChangePassword && (
                          <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                            Mot de passe temporaire
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-600 tabular-nums">
                        {acc.phone} · {acc.ordersCount} commande(s) rattachée(s)
                        {acc.createdAt
                          ? ` · Inscrit le ${new Date(acc.createdAt).toLocaleDateString('fr-FR')}`
                          : ''}
                      </div>

                      {tempPwd && (
                        <div className="inline-flex flex-wrap items-center gap-2 mt-1 px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-950">
                          <span>Mot de passe temporaire :</span>
                          <strong className="font-mono text-sm select-all">{tempPwd}</strong>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(tempPwd);
                              setCopiedAccountPwdId(acc.accountId);
                              setTimeout(() => setCopiedAccountPwdId(null), 2000);
                            }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-amber-300 font-semibold text-amber-900"
                          >
                            {copiedAccountPwdId === acc.accountId ? (
                              <Check className="w-3 h-3 text-[#2E9E6B]" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            Copier
                          </button>
                        </div>
                      )}
                    </div>

                    {isAdmin && (
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            setClientAccountBusyId(acc.accountId);
                            setClientAccountsError(null);
                            try {
                              const res = await resetClientAccountPasswordServer(acc.accountId);
                              setTempPasswordsMap((prev) => ({
                                ...prev,
                                [acc.accountId]: res.temporaryPassword,
                              }));
                              setClientAccounts((prev) =>
                                prev.map((a) =>
                                  a.accountId === acc.accountId
                                    ? { ...a, mustChangePassword: true }
                                    : a
                                )
                              );
                            } catch (err) {
                              setClientAccountsError(
                                err instanceof Error
                                  ? err.message
                                  : 'Impossible de réinitialiser le mot de passe.'
                              );
                            } finally {
                              setClientAccountBusyId(null);
                            }
                          }}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:bg-[#119DA4] hover:text-white transition-colors min-h-[38px]"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          Réinitialiser MDP
                        </button>

                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            setClientAccountBusyId(acc.accountId);
                            setClientAccountsError(null);
                            try {
                              const updated = await toggleClientAccountActiveServer(
                                acc.accountId,
                                !acc.active
                              );
                              setClientAccounts((prev) =>
                                prev.map((a) =>
                                  a.accountId === acc.accountId ? { ...a, active: updated.active } : a
                                )
                              );
                            } catch (err) {
                              setClientAccountsError(
                                err instanceof Error
                                  ? err.message
                                  : 'Impossible de modifier le statut du compte.'
                              );
                            } finally {
                              setClientAccountBusyId(null);
                            }
                          }}
                          className={`px-3.5 py-2 rounded-full text-xs font-semibold min-h-[38px] border transition-colors ${
                            acc.active
                              ? 'border-[#EF233C]/30 text-[#EF233C] hover:bg-[#EF233C]/10'
                              : 'border-[#2E9E6B]/40 text-[#237A52] hover:bg-[#2E9E6B]/10'
                          }`}
                        >
                          {acc.active ? 'Désactiver' : 'Réactiver'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* CRM Profiles */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="font-display text-xl text-[#26547C]">
              Répertoire clients CRM ({safeClients.length})
            </h2>
          </div>

          {filteredClients.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">
              Les fiches clients apparaissent automatiquement après validation d’un premier
              paiement.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredClients.map((client) => {
                const lastOrder = safeOrders.find(
                  (o) =>
                    (o.customerPhone || '').replace(/\D/g, '') ===
                    (client.phone || '').replace(/\D/g, '')
                );
                return (
                  <div key={client.clientId} className="py-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className="font-bold text-[#26547C]">{client.name}</div>
                        <div className="text-xs text-slate-600 tabular-nums">
                          {client.phone} · {client.totalOrders} commande(s)
                          {isAdmin ? ` · Total dépensé : ${formatFcfa(client.totalSpent)}` : ''}
                        </div>
                      </div>
                      {lastOrder && (
                        <button
                          type="button"
                          onClick={() => onReprintOrder(lastOrder)}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:bg-[#119DA4] hover:text-white transition-colors min-h-[40px] self-start"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Réimprimer ({lastOrder.orderNumber})
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={noteDrafts[client.clientId] ?? client.notes ?? ''}
                        onChange={(e) =>
                          setNoteDrafts((p) => ({ ...p, [client.clientId]: e.target.value }))
                        }
                        placeholder="Notes atelier (préférences papier, délais habituels)..."
                        className="flex-1 px-3.5 py-2 rounded-xl bg-[#EDF2F4] text-xs"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          const notes = noteDrafts[client.clientId] ?? client.notes ?? '';
                          if (useServerApi) {
                            await saveClientNotesServer(client.clientId, notes);
                            await onRefreshData?.();
                          } else {
                            await adminSaveClientNotes(client.clientId, notes);
                          }
                        }}
                        className="px-4 py-2 rounded-xl bg-[#26547C] text-white text-xs font-semibold"
                      >
                        Enregistrer note
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeTab === 'stats' && isAdmin) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl text-[#26547C]">
            Statistiques et exports comptables
          </h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => exportCsv('orders')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#26547C] text-white text-xs font-semibold min-h-[44px]"
            >
              <Download className="w-4 h-4" />
              Export Commandes (CSV)
            </button>
            <button
              type="button"
              onClick={() => exportCsv('payments')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#119DA4] text-white text-xs font-semibold min-h-[44px]"
            >
              <Download className="w-4 h-4" />
              Export Paiements (CSV)
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-3">
            <h3 className="font-bold text-base text-[#26547C]">
              Chiffre d’affaires par prestation
            </h3>
            <div className="divide-y divide-slate-100 text-sm">
              {Object.entries(stats.byService).map(([name, data]) => (
                <div key={name} className="py-2 flex justify-between">
                  <span className="text-slate-700">
                    {name} ({data.count})
                  </span>
                  <span className="font-bold tabular-nums">{formatFcfa(data.revenue)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-3">
            <h3 className="font-bold text-base text-[#26547C]">
              Encaissements par opérateur
            </h3>
            <div className="divide-y divide-slate-100 text-sm">
              {Object.entries(stats.byOperator).map(([op, total]) => (
                <div key={op} className="py-2 flex justify-between">
                  <span className="text-slate-700">{op}</span>
                  <span className="font-bold text-[#2E9E6B] tabular-nums">
                    {formatFcfa(total)}
                  </span>
                </div>
              ))}
              {Object.keys(stats.byOperator).length === 0 && (
                <p className="text-xs text-slate-500">Aucun paiement validé pour l’instant.</p>
              )}
            </div>
          </div>

          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-3">
            <h3 className="font-bold text-base text-[#26547C]">
              Commandes par statut &amp; délai
            </h3>
            <div className="text-sm bg-[#EDF2F4] p-3 rounded-2xl flex justify-between">
              <span>Délai moyen commande → livraison</span>
              <strong className="tabular-nums text-[#26547C]">{stats.avgHours} h</strong>
            </div>
            <div className="divide-y divide-slate-100 text-sm">
              {Object.entries(stats.byStatus).map(([st, count]) => (
                <div key={st} className="py-1.5 flex justify-between">
                  <span>{ORDER_STATUS_META[st as keyof typeof ORDER_STATUS_META]?.label || st}</span>
                  <span className="font-bold tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === 'settings' && isAdmin) {
    return (
      <div className="space-y-6">
        {/* Shop Settings */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl text-[#26547C]">
              Réglages de la boutique FBC Print
            </h2>
            <label className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-[#EDF2F4] cursor-pointer text-sm font-semibold text-[#26547C]">
              <input
                type="checkbox"
                checked={settingsDraft.isOpen}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, isOpen: e.target.checked })
                }
                className="w-4 h-4 accent-[#2E9E6B]"
              />
              {settingsDraft.isOpen ? 'Boutique ouverte aux commandes' : 'Fermeture temporaire activée'}
            </label>
          </div>

          {!settingsDraft.isOpen && (
            <div>
              <label className="block text-xs font-semibold text-[#EF233C] mb-1">
                Message affiché aux clients pendant la fermeture
              </label>
              <input
                type="text"
                value={settingsDraft.closedMessage}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, closedMessage: e.target.value })
                }
                className="w-full px-4 py-2.5 rounded-xl bg-[#EF233C]/5 border border-[#EF233C]/30 text-sm"
              />
            </div>
          )}

          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Nom de l’entreprise
              </label>
              <input
                type="text"
                value={settingsDraft.shopName}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, shopName: e.target.value })
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Téléphone / WhatsApp
              </label>
              <input
                type="text"
                value={settingsDraft.phone}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    phone: e.target.value,
                    whatsapp: e.target.value,
                  })
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                E-mail officiel
              </label>
              <input
                type="email"
                value={settingsDraft.email}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, email: e.target.value })
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Adresse
              </label>
              <input
                type="text"
                value={settingsDraft.address}
                onChange={(e) =>
                  setSettingsDraft({ ...settingsDraft, address: e.target.value })
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Acompte demandé (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={settingsDraft.depositPercent}
                onChange={(e) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    depositPercent: Number(e.target.value),
                  })
                }
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Validité devis (jours) / Rétention (jours)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min={1}
                  value={settingsDraft.quoteValidityDays}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      quoteValidityDays: Number(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
                />
                <input
                  type="number"
                  min={7}
                  value={settingsDraft.fileRetentionDays}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      fileRetentionDays: Number(e.target.value),
                    })
                  }
                  className="w-full px-3 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Conditions de commande (affichées sur les devis PDF)
            </label>
            <textarea
              rows={3}
              value={settingsDraft.termsText}
              onChange={(e) =>
                setSettingsDraft({ ...settingsDraft, termsText: e.target.value })
              }
              className="w-full px-4 py-2.5 rounded-xl bg-[#EDF2F4] text-sm"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={async () => {
                setSettingsError(null);
                try {
                  if (useServerApi) {
                    await saveShopSettingsServer(settingsDraft);
                    await onRefreshData?.();
                  } else {
                    await adminSaveShopSettings(settingsDraft, staffUser.email);
                  }
                  setSettingsSaved(true);
                  setTimeout(() => setSettingsSaved(false), 2000);
                } catch (err) {
                  setSettingsError(
                    err instanceof Error
                      ? err.message
                      : 'Impossible d’enregistrer les réglages.'
                  );
                }
              }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#26547C] text-white text-sm font-semibold min-h-[44px]"
            >
              <Save className="w-4 h-4" />
              Enregistrer les réglages
            </button>
            {settingsSaved && (
              <span className="text-sm font-semibold text-[#2E9E6B]">
                Réglages sauvegardés !
              </span>
            )}
            {settingsError && (
              <span className="text-xs font-medium text-[#EF233C]">{settingsError}</span>
            )}
          </div>
        </div>

        {/* Team & Roles (Server-Generated Unique ID + Server-Hashed Custom Password) */}
        <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 shadow-sm space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="font-bold text-lg text-[#26547C] flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-[#119DA4]" />
                Équipe d’atelier et accès (Rôles)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                L’identifiant unique est généré automatiquement côté serveur. Le mot de
                passe personnalisé est haché, stocké et vérifié uniquement sur le serveur
                à la connexion (aucun e-mail requis).
              </p>
            </div>
            <button
              type="button"
              onClick={loadStaffAccess}
              disabled={staffLoading}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:border-[#119DA4] self-start sm:self-auto"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${staffLoading ? 'animate-spin' : ''}`} />
              Actualiser
            </button>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setStaffError(null);
              if (newAccessName.trim().length < 2) {
                setStaffError('Saisissez le nom complet du collaborateur (min. 2 caractères).');
                return;
              }
              if (newAccessPassword.trim().length < 6) {
                setStaffError('Définissez un mot de passe personnalisé d’au moins 6 caractères.');
                return;
              }
              setCreatingAccess(true);
              try {
                const created = await createStaffAccess({
                  displayName: newAccessName.trim(),
                  role: newAccessRole,
                  password: newAccessPassword,
                });
                setCreatedCredentialNotice(created);
                setNewAccessName('');
                setNewAccessPassword('');
                await loadStaffAccess();
              } catch (err) {
                setStaffError(
                  err instanceof Error ? err.message : 'Impossible de générer cet accès.'
                );
              } finally {
                setCreatingAccess(false);
              }
            }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end"
          >
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Nom du collaborateur
              </label>
              <input
                type="text"
                value={newAccessName}
                onChange={(e) => setNewAccessName(e.target.value)}
                placeholder="Ex : Moussa Ouédraogo"
                maxLength={120}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Rôle attribué
              </label>
              <select
                value={newAccessRole}
                onChange={(e) => setNewAccessRole(e.target.value as 'operator' | 'admin')}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              >
                <option value="operator">Opérateur d’atelier</option>
                <option value="admin">Administrateur principal</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Mot de passe personnalisé
              </label>
              <div className="relative">
                <input
                  type={showNewAccessPassword ? 'text' : 'password'}
                  value={newAccessPassword}
                  onChange={(e) => setNewAccessPassword(e.target.value)}
                  placeholder="Min. 6 caractères"
                  maxLength={128}
                  className="w-full pl-3.5 pr-10 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
                />
                <button
                  type="button"
                  onClick={() => setShowNewAccessPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-[#26547C] p-1"
                  aria-label={
                    showNewAccessPassword
                      ? 'Masquer le mot de passe'
                      : 'Afficher le mot de passe'
                  }
                >
                  {showNewAccessPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={creatingAccess}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[#119DA4] text-white text-sm font-semibold min-h-[44px] hover:bg-[#0e848a] disabled:opacity-60"
            >
              {creatingAccess ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4" />
              )}
              {creatingAccess ? 'Génération...' : 'Générer l’accès'}
            </button>
          </form>

          {staffError && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-[#EF233C] bg-[#EF233C]/10 border border-[#EF233C]/20 px-4 py-3 rounded-2xl">
              <span>{staffError}</span>
              <button
                type="button"
                onClick={loadStaffAccess}
                className="px-3 py-1 rounded-full bg-white text-[#26547C] font-semibold border border-slate-200 hover:border-[#119DA4] shrink-0"
              >
                Réessayer
              </button>
            </div>
          )}

          {createdCredentialNotice && (
            <div className="p-4 rounded-2xl bg-[#2E9E6B]/10 border border-[#2E9E6B]/30 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#237A52] flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4" />
                  Accès généré côté serveur pour {createdCredentialNotice.displayName}
                </span>
                <button
                  type="button"
                  onClick={() => setCreatedCredentialNotice(null)}
                  className="text-[11px] font-semibold text-slate-500 hover:text-black"
                >
                  Fermer
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-xs text-slate-700">Identifiant unique :</span>
                <code className="px-3 py-1 rounded-lg bg-white border border-[#2E9E6B]/30 font-mono text-sm font-bold text-[#26547C]">
                  {createdCredentialNotice.accessId}
                </code>
                <button
                  type="button"
                  onClick={() => copyAccessId(createdCredentialNotice.accessId)}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-[#26547C] text-white text-xs font-semibold"
                >
                  {copiedAccessId === createdCredentialNotice.accessId ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Copié
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copier l’ID
                    </>
                  )}
                </button>
              </div>
              <p className="text-[11px] text-slate-600">
                Transmettez cet identifiant unique et le mot de passe personnalisé que vous
                avez saisi au collaborateur. Le mot de passe est chiffré côté serveur et ne
                pourra pas être affiché à nouveau.
              </p>
            </div>
          )}

          {/* List of Server-Generated Accesses */}
          <div className="divide-y divide-slate-100 text-sm">
            {safeStaffCredentials.map((cred) => {
              const isSelf = staffUser.accessId === cred.accessId;
              return (
                <div key={cred.accessId} className="py-3 space-y-2.5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[#26547C]">
                          {cred.displayName}
                        </span>
                        <code className="px-2 py-0.5 rounded-md bg-[#EDF2F4] font-mono text-xs font-bold text-[#26547C]">
                          {cred.accessId}
                        </code>
                        <button
                          type="button"
                          onClick={() => copyAccessId(cred.accessId)}
                          className="text-slate-400 hover:text-[#119DA4] p-0.5"
                          title="Copier l’identifiant"
                          aria-label={`Copier l’identifiant ${cred.accessId}`}
                        >
                          {copiedAccessId === cred.accessId ? (
                            <Check className="w-3.5 h-3.5 text-[#2E9E6B]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <span
                          className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                            cred.active
                              ? 'bg-[#2E9E6B]/15 text-[#237A52]'
                              : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          {cred.active ? 'Actif' : 'Désactivé'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Créé par {cred.createdBy}
                        {cred.lastLoginAt
                          ? ` · Dernière connexion : ${new Date(
                              cred.lastLoginAt
                            ).toLocaleString('fr-FR')}`
                          : ' · Jamais connecté'}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <select
                        value={cred.role}
                        onChange={async (e) => {
                          const nextRole = e.target.value as 'operator' | 'admin';
                          setStaffError(null);
                          try {
                            await updateStaffAccess(cred.accessId, { role: nextRole });
                            await loadStaffAccess();
                          } catch (err) {
                            setStaffError(
                              err instanceof Error
                                ? err.message
                                : 'Impossible de changer le rôle.'
                            );
                          }
                        }}
                        className="text-xs font-semibold px-2.5 py-1.5 rounded-xl bg-[#EDF2F4] text-[#26547C]"
                      >
                        <option value="operator">Opérateur</option>
                        <option value="admin">Admin</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => {
                          setResetTargetId(
                            resetTargetId === cred.accessId ? null : cred.accessId
                          );
                          setResetPasswordDraft('');
                          setShowResetPassword(false);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:bg-[#119DA4]/15"
                      >
                        Mot de passe
                      </button>

                      {!isSelf && (
                        <>
                          <button
                            type="button"
                            onClick={async () => {
                              setStaffError(null);
                              try {
                                await updateStaffAccess(cred.accessId, {
                                  active: !cred.active,
                                });
                                await loadStaffAccess();
                              } catch (err) {
                                setStaffError(
                                  err instanceof Error
                                    ? err.message
                                    : 'Impossible de modifier le statut.'
                                );
                              }
                            }}
                            className={`text-xs font-semibold px-2.5 py-1.5 rounded-xl ${
                              cred.active
                                ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                : 'text-[#237A52] bg-[#2E9E6B]/15'
                            }`}
                          >
                            {cred.active ? 'Désactiver' : 'Réactiver'}
                          </button>

                          {confirmDeleteId === cred.accessId ? (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  setStaffError(null);
                                  try {
                                    await deleteStaffAccess(cred.accessId);
                                    setConfirmDeleteId(null);
                                    await loadStaffAccess();
                                  } catch (err) {
                                    setStaffError(
                                      err instanceof Error
                                        ? err.message
                                        : 'Impossible de supprimer cet accès.'
                                    );
                                  }
                                }}
                                className="px-2.5 py-1.5 rounded-xl bg-[#EF233C] text-white text-xs font-semibold"
                              >
                                Confirmer
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-xs text-slate-500 px-1.5"
                              >
                                Annuler
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(cred.accessId)}
                              className="p-1.5 text-slate-400 hover:text-[#EF233C]"
                              aria-label={`Supprimer ${cred.accessId}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {resetTargetId === cred.accessId && (
                    <div className="flex flex-wrap items-center gap-2 bg-[#EDF2F4]/70 p-3 rounded-xl">
                      <div className="relative flex-1 min-w-[200px]">
                        <input
                          type={showResetPassword ? 'text' : 'password'}
                          value={resetPasswordDraft}
                          onChange={(e) => setResetPasswordDraft(e.target.value)}
                          placeholder="Nouveau mot de passe personnalisé (min. 6 caractères)"
                          className="w-full pl-3 pr-9 py-2 rounded-lg bg-white border border-slate-200 text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => setShowResetPassword((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                        >
                          {showResetPassword ? (
                            <EyeOff className="w-3.5 h-3.5" />
                          ) : (
                            <Eye className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          if (resetPasswordDraft.trim().length < 6) {
                            setStaffError(
                              'Le nouveau mot de passe doit contenir au moins 6 caractères.'
                            );
                            return;
                          }
                          setStaffError(null);
                          try {
                            await updateStaffAccess(cred.accessId, {
                              password: resetPasswordDraft,
                            });
                            setResetTargetId(null);
                            setResetPasswordDraft('');
                            await loadStaffAccess();
                          } catch (err) {
                            setStaffError(
                              err instanceof Error
                                ? err.message
                                : 'Impossible de mettre à jour le mot de passe.'
                            );
                          }
                        }}
                        className="px-4 py-2 rounded-lg bg-[#26547C] text-white text-xs font-semibold"
                      >
                        Enregistrer
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetTargetId(null);
                          setResetPasswordDraft('');
                        }}
                        className="text-xs text-slate-500 px-2"
                      >
                        Annuler
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {!staffLoading && safeStaffCredentials.length === 0 && (
              <p className="text-xs text-slate-500 py-4 text-center">
                Aucun accès par identifiant unique créé pour le moment. Utilisez le
                formulaire ci-dessus pour en générer un.
              </p>
            )}
          </div>

          {/* Legacy Google Accounts (read/toggle) */}
          {safeGoogleStaffList.length > 0 && (
            <div className="pt-3 border-t border-slate-200 space-y-2">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                Comptes Google administrateur associés
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                {safeGoogleStaffList.map((u) => (
                  <div
                    key={u.uid}
                    className="py-2 flex items-center justify-between gap-3"
                  >
                    <div>
                      <span className="font-semibold text-[#26547C]">
                        {u.displayName || u.email}
                      </span>{' '}
                      <span className="text-slate-500">({u.email})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold px-2.5 py-0.5 rounded-full bg-[#EDF2F4] text-[#26547C]">
                        {u.role === 'admin' ? 'Admin' : 'Opérateur'}
                      </span>
                      {u.email !== 'ouattaraabdoulaye479@gmail.com' && (
                        <button
                          type="button"
                          onClick={async () => {
                            await updateGoogleStaffStatus(u.uid, !u.active, u.role);
                            await loadStaffAccess();
                          }}
                          className="font-semibold text-[#EF233C]"
                        >
                          {u.active ? 'Désactiver' : 'Réactiver'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Immutable Audit Log (Daily & Monthly Archive) */}
        <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-lg text-[#26547C]">
                Journal des actions sensibles
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Suivi journalier en direct avec historique des jours et mois précédents.
              </p>
            </div>

            <div className="inline-flex items-center p-1 rounded-xl bg-[#EDF2F4] self-start sm:self-auto">
              <button
                type="button"
                onClick={() => {
                  setAuditViewMode('day');
                  setAuditReloadTick(0);
                }}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                  auditViewMode === 'day'
                    ? 'bg-white text-[#26547C] shadow-sm'
                    : 'text-slate-600 hover:text-[#26547C]'
                }`}
              >
                Par jour
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuditViewMode('month');
                  setAuditReloadTick((n) => n + 1);
                }}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                  auditViewMode === 'month'
                    ? 'bg-white text-[#26547C] shadow-sm'
                    : 'text-slate-600 hover:text-[#26547C]'
                }`}
              >
                Par mois
              </button>
            </div>
          </div>

          {/* Period Navigation & Search */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#EDF2F4]/70 border border-slate-200/80">
            {auditViewMode === 'day' ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAuditSelectedDay((d) => shiftAuditDay(d, -1));
                    setAuditReloadTick(0);
                  }}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-[#26547C] hover:border-[#119DA4] min-h-[40px]"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Jour préc.
                </button>

                <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-slate-200 min-h-[40px]">
                  <Calendar className="w-4 h-4 text-[#119DA4] shrink-0" />
                  <input
                    type="date"
                    value={auditSelectedDay}
                    max={todayDayStr}
                    onChange={(e) => {
                      if (e.target.value) {
                        setAuditSelectedDay(e.target.value);
                        setAuditReloadTick(0);
                      }
                    }}
                    className="text-xs font-semibold text-[#26547C] bg-transparent focus:outline-none tabular-nums"
                  />
                </label>

                <button
                  type="button"
                  disabled={auditSelectedDay >= todayDayStr}
                  onClick={() => {
                    setAuditSelectedDay((d) => {
                      const next = shiftAuditDay(d, 1);
                      return next > todayDayStr ? todayDayStr : next;
                    });
                    setAuditReloadTick(0);
                  }}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-[#26547C] hover:border-[#119DA4] disabled:opacity-45 min-h-[40px]"
                >
                  Jour suiv.
                  <ChevronRight className="w-4 h-4" />
                </button>

                {auditSelectedDay !== todayDayStr && (
                  <button
                    type="button"
                    onClick={() => {
                      setAuditSelectedDay(todayDayStr);
                      setAuditReloadTick(0);
                    }}
                    className="px-3 py-2 rounded-xl bg-[#119DA4]/15 text-[#0E7F85] text-xs font-bold hover:bg-[#119DA4]/25 min-h-[40px]"
                  >
                    Aujourd’hui
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAuditSelectedMonth((m) => shiftAuditMonth(m, -1));
                  }}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-[#26547C] hover:border-[#119DA4] min-h-[40px]"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Mois préc.
                </button>

                <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-slate-200 min-h-[40px]">
                  <Calendar className="w-4 h-4 text-[#119DA4] shrink-0" />
                  <input
                    type="month"
                    value={auditSelectedMonth}
                    max={currentMonthStr}
                    onChange={(e) => {
                      if (e.target.value) setAuditSelectedMonth(e.target.value);
                    }}
                    className="text-xs font-semibold text-[#26547C] bg-transparent focus:outline-none tabular-nums"
                  />
                </label>

                <button
                  type="button"
                  disabled={auditSelectedMonth >= currentMonthStr}
                  onClick={() => {
                    setAuditSelectedMonth((m) => {
                      const next = shiftAuditMonth(m, 1);
                      return next > currentMonthStr ? currentMonthStr : next;
                    });
                  }}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-[#26547C] hover:border-[#119DA4] disabled:opacity-45 min-h-[40px]"
                >
                  Mois suiv.
                  <ChevronRight className="w-4 h-4" />
                </button>

                {auditSelectedMonth !== currentMonthStr && (
                  <button
                    type="button"
                    onClick={() => setAuditSelectedMonth(currentMonthStr)}
                    className="px-3 py-2 rounded-xl bg-[#119DA4]/15 text-[#0E7F85] text-xs font-bold hover:bg-[#119DA4]/25 min-h-[40px]"
                  >
                    Mois en cours
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 flex-1 lg:max-w-xs">
              <div className="relative flex-1 min-w-0">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={auditSearch}
                  onChange={(e) => setAuditSearch(e.target.value)}
                  placeholder="Filtrer (action, cible, auteur)..."
                  className="w-full pl-8 pr-3 py-2 rounded-xl bg-white border border-slate-200 text-xs focus:outline-none focus:border-[#119DA4] min-h-[40px]"
                />
              </div>
              <button
                type="button"
                onClick={() => setAuditReloadTick((n) => n + 1)}
                title="Actualiser le journal"
                className="p-2 rounded-xl bg-white border border-slate-200 text-[#26547C] hover:border-[#119DA4] min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0"
                aria-label="Actualiser le journal"
              >
                <RefreshCw className={`w-4 h-4 ${auditLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Selected Period Summary Header */}
          <div className="flex items-center justify-between gap-2 text-xs text-slate-600 px-1">
            <span className="font-semibold text-[#26547C] capitalize">
              {auditViewMode === 'day'
                ? (() => {
                    const [y, m, d] = auditSelectedDay.split('-').map(Number);
                    const formatted = new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    });
                    return auditSelectedDay === todayDayStr
                      ? `Aujourd’hui · ${formatted}`
                      : formatted;
                  })()
                : (() => {
                    const [y, m] = auditSelectedMonth.split('-').map(Number);
                    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', {
                      month: 'long',
                      year: 'numeric',
                    });
                  })()}
            </span>
            <span className="tabular-nums font-medium">
              {displayedAuditLogs.length} action{displayedAuditLogs.length > 1 ? 's' : ''}
            </span>
          </div>

          {auditError && (
            <p className="text-xs font-medium text-[#EF233C] bg-[#EF233C]/10 px-3.5 py-2.5 rounded-xl">
              {auditError}
            </p>
          )}

          {auditLoading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin text-[#119DA4]" />
              Chargement des journaux...
            </div>
          ) : auditViewMode === 'day' ? (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 text-xs border border-slate-100 rounded-2xl px-3">
              {displayedAuditLogs.map((log) => {
                const dt = parseAuditCreatedAt(log.createdAt);
                const timeStr = dt
                  ? dt.toLocaleTimeString('fr-FR', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : 'À l’instant';
                return (
                  <div
                    key={log.logId}
                    className="py-2.5 flex flex-col sm:flex-row sm:items-start justify-between gap-1.5 sm:gap-4"
                  >
                    <div className="min-w-0 flex-1 break-words">
                      <strong className="text-[#26547C]">{log.action}</strong>
                      <span className="text-slate-400"> · </span>
                      <span className="font-mono text-[11px] text-slate-700">{log.targetId}</span>
                      <span className="text-slate-400"> · </span>
                      <span className="text-slate-600">{log.actorEmail}</span>
                      {log.details ? (
                        <span className="text-slate-700"> — {log.details}</span>
                      ) : null}
                    </div>
                    <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
                      {timeStr}
                    </span>
                  </div>
                );
              })}
              {displayedAuditLogs.length === 0 && (
                <p className="text-slate-500 py-6 text-center">
                  Aucune action sensible enregistrée pour cette journée.
                </p>
              )}
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-3 pr-1">
              {monthlyGroupedAuditLogs.map(([dayKey, dayLogs]) => {
                const [y, m, d] = dayKey.split('-').map(Number);
                const dayTitle = new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                });
                return (
                  <div
                    key={dayKey}
                    className="border border-slate-200 rounded-2xl overflow-hidden"
                  >
                    <div className="bg-[#EDF2F4] px-3.5 py-2 flex items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-[#26547C] capitalize">{dayTitle}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-slate-600 tabular-nums">
                          {dayLogs.length} action{dayLogs.length > 1 ? 's' : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAuditSelectedDay(dayKey);
                            setAuditViewMode('day');
                            setAuditReloadTick(0);
                          }}
                          className="font-semibold text-[#119DA4] hover:underline"
                        >
                          Ouvrir le jour
                        </button>
                      </div>
                    </div>
                    <div className="divide-y divide-slate-100 px-3.5 text-xs bg-white">
                      {dayLogs.map((log) => {
                        const dt = parseAuditCreatedAt(log.createdAt);
                        const timeStr = dt
                          ? dt.toLocaleTimeString('fr-FR', {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })
                          : '--:--';
                        return (
                          <div
                            key={log.logId}
                            className="py-2 flex flex-col sm:flex-row sm:items-start justify-between gap-1 sm:gap-4"
                          >
                            <div className="min-w-0 flex-1 break-words">
                              <strong className="text-[#26547C]">{log.action}</strong>
                              <span className="text-slate-400"> · </span>
                              <span className="font-mono text-[11px] text-slate-700">
                                {log.targetId}
                              </span>
                              <span className="text-slate-400"> · </span>
                              <span className="text-slate-600">{log.actorEmail}</span>
                              {log.details ? (
                                <span className="text-slate-700"> — {log.details}</span>
                              ) : null}
                            </div>
                            <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
                              {timeStr}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {monthlyGroupedAuditLogs.length === 0 && (
                <p className="text-xs text-slate-500 py-6 text-center border border-slate-100 rounded-2xl">
                  Aucune action sensible enregistrée pour ce mois.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
};
