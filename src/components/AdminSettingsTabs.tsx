import React, { useEffect, useMemo, useState } from 'react';
import {
  Download,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  UploadCloud,
  UserPlus,
} from 'lucide-react';
import { getServiceImageSrc, SERVICE_IMAGE_OPTIONS } from '../data/defaults';
import {
  adminCreateInvite,
  adminDeleteService,
  adminListStaff,
  adminSaveClientNotes,
  adminSaveService,
  adminSaveShopSettings,
  adminUpdateStaffStatus,
} from '../lib/firestoreApi';
import { formatFcfa, isApparelSlug } from '../lib/pricing';
import { startResumableUpload } from '../lib/uploadClient';
import {
  ORDER_STATUS_META,
  type AdminInvite,
  type AdminUser,
  type AuditLog,
  type ClientProfile,
  type Order,
  type Payment,
  type PricingMode,
  type PrintService,
  type ServiceSlug,
  type ShopSettings,
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
}) => {
  const isAdmin = staffUser.role === 'admin';

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

  // --- Clients state ---
  const [clientSearch, setClientSearch] = useState('');
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  // --- Settings & Staff state ---
  const [settingsDraft, setSettingsDraft] = useState<ShopSettings>(settings);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [staffList, setStaffList] = useState<AdminUser[]>([]);
  const [invitesList, setInvitesList] = useState<AdminInvite[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'operator' | 'admin'>('operator');

  useEffect(() => {
    setSettingsDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (activeTab === 'settings' && isAdmin) {
      adminListStaff()
        .then((res) => {
          setStaffList(res.users);
          setInvitesList(res.invites);
        })
        .catch(() => {});
    }
  }, [activeTab, isAdmin]);

  // Stats computation
  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byService: Record<string, { count: number; revenue: number }> = {};
    const byOperator: Record<string, number> = {};
    let totalTurnaroundHours = 0;
    let deliveredCount = 0;

    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      for (const it of o.items) {
        if (!byService[it.serviceName]) {
          byService[it.serviceName] = { count: 0, revenue: 0 };
        }
        byService[it.serviceName].count += 1;
        byService[it.serviceName].revenue += it.subtotal;
      }
      if (o.status === 'livree' && o.statusHistory.length >= 2) {
        const first = new Date(o.statusHistory[0].timestamp).getTime();
        const last = new Date(o.statusHistory[o.statusHistory.length - 1].timestamp).getTime();
        if (!Number.isNaN(first) && !Number.isNaN(last) && last > first) {
          totalTurnaroundHours += (last - first) / (1000 * 60 * 60);
          deliveredCount += 1;
        }
      }
    }

    for (const p of payments) {
      if (p.status === 'valide') {
        byOperator[p.methodName] = (byOperator[p.methodName] || 0) + p.declaredAmount;
      }
    }

    const avgHours = deliveredCount > 0 ? Math.round(totalTurnaroundHours / deliveredCount) : 0;
    return { byStatus, byService, byOperator, avgHours };
  }, [orders, payments]);

  const exportCsv = (type: 'orders' | 'payments') => {
    const bom = '\uFEFF';
    let csv = '';
    if (type === 'orders') {
      csv =
        'Numero;Client;Telephone;Statut;StatutPaiement;TotalFCFA;PayeFCFA;Urgent;Prestations\n' +
        orders
          .map(
            (o) =>
              `"${o.orderNumber}";"${o.customerName}";"${o.customerPhone}";"${ORDER_STATUS_META[o.status].label}";"${o.paymentStatus}";${o.totalAmount};${o.paidAmount || 0};${o.urgent ? 'Oui' : 'Non'};"${o.items.map((i) => i.serviceName).join(', ')}"`
          )
          .join('\n');
    } else {
      csv =
        'ID;Commande;Client;Operateur;TelephoneDepot;Reference;MontantFCFA;Statut;Validateur\n' +
        payments
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
            {services.map((srv) => (
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
                    onClick={() =>
                      adminSaveService(
                        { ...srv, active: !srv.active },
                        staffUser.email
                      )
                    }
                    className="px-4 py-2 rounded-full border border-slate-200 text-xs font-semibold min-h-[40px]"
                  >
                    {srv.active ? 'Désactiver' : 'Activer'}
                  </button>
                  <button
                    type="button"
                    onClick={() => adminDeleteService(srv.id, staffUser.email)}
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
                  await adminSaveService(payload, staffUser.email);
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
                await adminSaveService(
                  {
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
                    sortOrder: services.length + 1,
                    config: defaultConfig,
                  },
                  staffUser.email
                );
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
    const filteredClients = clients.filter(
      (c) =>
        c.name.toLowerCase().includes(clientSearch.toLowerCase()) ||
        c.phone.includes(clientSearch)
    );
    return (
      <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="font-display text-xl text-[#26547C]">
            Répertoire clients ({clients.length})
          </h2>
          <input
            type="search"
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            placeholder="Rechercher par nom ou téléphone..."
            className="px-4 py-2.5 rounded-full bg-[#EDF2F4] text-sm min-w-[260px]"
          />
        </div>

        {filteredClients.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">
            Les fiches clients apparaissent automatiquement après validation d’un premier
            paiement.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredClients.map((client) => {
              const lastOrder = orders.find(
                (o) =>
                  o.customerPhone.replace(/\D/g, '') ===
                  client.phone.replace(/\D/g, '')
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
                      onClick={() =>
                        adminSaveClientNotes(
                          client.clientId,
                          noteDrafts[client.clientId] ?? client.notes ?? ''
                        )
                      }
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

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={async () => {
                await adminSaveShopSettings(settingsDraft, staffUser.email);
                setSettingsSaved(true);
                setTimeout(() => setSettingsSaved(false), 2000);
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
          </div>
        </div>

        {/* Team & Roles */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
          <h3 className="font-bold text-lg text-[#26547C]">
            Équipe d’atelier et accès (Rôles)
          </h3>

          <div className="grid sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs text-slate-600 mb-1">E-mail Google</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="operateur@gmail.com"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Nom</label>
              <input
                type="text"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="Prénom Nom"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Rôle</label>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'operator' | 'admin')}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#EDF2F4] text-sm min-h-[44px]"
              >
                <option value="operator">Opérateur d’atelier</option>
                <option value="admin">Administrateur principal</option>
              </select>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!inviteEmail.trim()) return;
                await adminCreateInvite(
                  {
                    email: inviteEmail.trim().toLowerCase(),
                    displayName: inviteName.trim(),
                    role: inviteRole,
                    invitedBy: staffUser.email,
                  },
                  staffUser.email
                );
                setInviteEmail('');
                setInviteName('');
                const refreshed = await adminListStaff();
                setStaffList(refreshed.users);
                setInvitesList(refreshed.invites);
              }}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[#119DA4] text-white text-sm font-semibold min-h-[44px]"
            >
              <UserPlus className="w-4 h-4" />
              Inviter
            </button>
          </div>

          <div className="divide-y divide-slate-100 text-sm">
            {staffList.map((u) => (
              <div key={u.uid} className="py-2.5 flex items-center justify-between gap-3">
                <div>
                  <span className="font-semibold text-[#26547C]">
                    {u.displayName || u.email}
                  </span>{' '}
                  <span className="text-xs text-slate-500">({u.email})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#EDF2F4] text-[#26547C]">
                    {u.role === 'admin' ? 'Admin' : 'Opérateur'}
                  </span>
                  {u.email !== 'ouattaraabdoulaye479@gmail.com' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await adminUpdateStaffStatus(
                          u.uid,
                          !u.active,
                          u.role,
                          staffUser.email
                        );
                        const refreshed = await adminListStaff();
                        setStaffList(refreshed.users);
                      }}
                      className="text-xs font-semibold text-[#EF233C]"
                    >
                      {u.active ? 'Désactiver' : 'Réactiver'}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {invitesList.map((inv) => (
              <div key={inv.email} className="py-2 text-xs text-slate-500 flex justify-between">
                <span>Invitation en attente : {inv.email}</span>
                <span>Rôle : {inv.role}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Immutable Audit Log */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-[#26547C]">
            Journal des actions sensibles
          </h3>
          <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 text-xs">
            {auditLogs.map((log) => (
              <div key={log.logId} className="py-2 flex justify-between gap-3">
                <div>
                  <strong className="text-[#26547C]">{log.action}</strong> ·{' '}
                  <span>{log.targetId}</span> ·{' '}
                  <span className="text-slate-600">{log.actorEmail}</span>
                  {log.details ? ` — ${log.details}` : ''}
                </div>
              </div>
            ))}
            {auditLogs.length === 0 && (
              <p className="text-slate-500 py-4">Aucune action enregistrée pour le moment.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
};
