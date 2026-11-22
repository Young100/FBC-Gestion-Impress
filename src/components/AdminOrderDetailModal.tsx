import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  Eye,
  FileWarning,
  Loader2,
  MessageCircle,
  Save,
  X,
} from 'lucide-react';
import {
  fetchStaffProtectedBlobUrl,
  getStaffAuthHeaders,
  notifyOrderPushServer,
  triggerStaffProtectedDownload,
  updateOrderFieldsServer,
  updateOrderStatusServer,
} from '../lib/adminApi';
import {
  adminUpdateOrderFields,
  adminUpdateOrderStatus,
} from '../lib/firestoreApi';
import { generateQuotePdf, generateReceiptPdf } from '../lib/pdfGenerator';
import {
  formatBytes,
  formatFcfa,
  getJerseySizeBreakdown,
  getNonZeroApparelSizes,
} from '../lib/pricing';
import {
  ORDER_STATUS_META,
  PAYMENT_STATUS_META,
  type AdminUser,
  type Order,
  type OrderStatus,
  type ShopSettings,
} from '../types/fbc';
import { useToast } from './ToastProvider';

interface AdminOrderDetailModalProps {
  order: Order;
  staffUser: AdminUser;
  settings: ShopSettings;
  onClose: () => void;
  onRefreshData?: () => Promise<void> | void;
}

const ALL_STATUSES: OrderStatus[] = [
  'recue',
  'en_verification',
  'fichier_a_corriger',
  'en_attente_paiement',
  'payee',
  'en_production',
  'prete',
  'livree',
  'annulee',
];

export const AdminOrderDetailModal: React.FC<AdminOrderDetailModalProps> = ({
  order,
  staffUser,
  settings,
  onClose,
  onRefreshData,
}) => {
  const { showToast } = useToast();
  const [selectedStatus, setSelectedStatus] = useState<OrderStatus>(order.status);
  const [statusNote, setStatusNote] = useState('');
  const [correctionMsg, setCorrectionMsg] = useState(order.correctionRequestMessage || '');
  const [cancelReason, setCancelReason] = useState(order.cancellationReason || '');
  const [internalNotes, setInternalNotes] = useState(order.internalNotes || '');
  const [promisedDate, setPromisedDate] = useState(order.promisedDeliveryDate || '');
  const [isUrgent, setIsUrgent] = useState(order.urgent);
  const [discountAmount, setDiscountAmount] = useState<number>(order.discountAmount || 0);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{
    fileId: string;
    name: string;
    ext: string;
  } | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  useEffect(() => {
    if (!previewFile) {
      setPreviewBlobUrl(null);
      setPreviewError(null);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewBlobUrl(null);

    fetchStaffProtectedBlobUrl(`/api/files/${previewFile.fileId}/preview`)
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setPreviewBlobUrl(url);
      })
      .catch((err) => {
        if (active) {
          setPreviewError(
            err instanceof Error ? err.message : 'Aperçu indisponible.'
          );
        }
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [previewFile]);

  const isAdmin = staffUser.role === 'admin';
  const useServerApi = staffUser.authMethod === 'credentials';
  const statusMeta = ORDER_STATUS_META[order.status];
  const paymentMeta = PAYMENT_STATUS_META[order.paymentStatus];

  const handleStatusSave = async () => {
    setSaving(true);
    setActionError(null);
    try {
      if (useServerApi) {
        await updateOrderStatusServer({
          orderId: order.orderId,
          newStatus: selectedStatus,
          note: statusNote,
          correctionMessage:
            selectedStatus === 'fichier_a_corriger' ? correctionMsg : undefined,
          cancellationReason: selectedStatus === 'annulee' ? cancelReason : undefined,
        });
        await onRefreshData?.();
      } else {
        await adminUpdateOrderStatus({
          order,
          newStatus: selectedStatus,
          actorEmail: staffUser.email,
          actorRole: staffUser.role,
          note: statusNote,
          correctionMessage:
            selectedStatus === 'fichier_a_corriger' ? correctionMsg : undefined,
          cancellationReason: selectedStatus === 'annulee' ? cancelReason : undefined,
        });
        void notifyOrderPushServer({
          orderId: order.orderId,
          eventType: 'status_changed',
          newStatus: selectedStatus,
          note: statusNote,
          correctionMessage:
            selectedStatus === 'fichier_a_corriger' ? correctionMsg : undefined,
          cancellationReason: selectedStatus === 'annulee' ? cancelReason : undefined,
        });
      }
      setStatusNote('');
      showToast({
        id: `modal_status_${order.orderId}_${selectedStatus}`,
        badge: order.orderNumber,
        title: `Statut mis à jour : ${ORDER_STATUS_META[selectedStatus].label}`,
        message: `Le suivi client de ${order.customerName} a été actualisé en temps réel.`,
        variant: 'success',
        durationMs: 5000,
      });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Erreur lors du changement de statut.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleMetaSave = async () => {
    setSaving(true);
    setActionError(null);
    try {
      const nextUrgentFee = isUrgent
        ? Math.round((order.subtotal * (settings.urgentSurchargePercent || 25)) / 100)
        : 0;
      const nextTotal = Math.max(
        0,
        order.subtotal + order.deliveryFee + nextUrgentFee - Math.max(0, discountAmount)
      );
      const updates = {
        internalNotes,
        promisedDeliveryDate: promisedDate,
        urgent: isUrgent,
        urgentFee: nextUrgentFee,
        discountAmount: Math.max(0, discountAmount),
        totalAmount: nextTotal,
      };
      if (useServerApi) {
        await updateOrderFieldsServer(order.orderId, updates);
        await onRefreshData?.();
      } else {
        await adminUpdateOrderFields(order.orderId, updates);
      }
      showToast({
        id: `modal_meta_${order.orderId}`,
        badge: order.orderNumber,
        title: 'Informations enregistrées',
        message: 'Notes internes, échéance et tarification mises à jour.',
        variant: 'success',
        durationMs: 4500,
      });
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Erreur lors de l’enregistrement.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadAllZip = async () => {
    const activeFiles = order.files.filter((f) => !f.replaced);
    if (activeFiles.length === 0) return;
    setZipLoading(true);
    setZipError(null);
    try {
      const headers = await getStaffAuthHeaders({
        'Content-Type': 'application/json',
      });
      const res = await fetch(`/api/orders/${order.orderId}/files-zip`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          orderNumber: order.orderNumber,
          files: activeFiles.map((f) => ({
            fileId: f.fileId,
            originalName: f.originalName,
            slotLabel: f.slotLabel,
          })),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Impossible de générer l’archive ZIP.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${order.orderNumber}_fichiers_originaux.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      setZipError(
        err instanceof Error ? err.message : 'Erreur lors du téléchargement ZIP.'
      );
    } finally {
      setZipLoading(false);
    }
  };

  const whatsappClean = order.customerPhone.replace(/\D/g, '');
  const trackingLink = `${window.location.origin}/client/?code=${encodeURIComponent(order.trackingCode)}`;
  const messageTemplates = [
    {
      label: 'Commande reçue',
      text: `Bonjour ${order.customerName}, nous avons bien reçu votre commande ${order.orderNumber}. Connectez-vous à votre espace client FBC Print pour la suivre (code : ${order.trackingCode}) : ${trackingLink}`,
    },
    {
      label: 'Fichier à corriger',
      text: `Bonjour ${order.customerName}, concernant votre commande ${order.orderNumber}, un fichier nécessite une correction : ${order.correctionRequestMessage || 'merci de vérifier votre espace client'}. Connectez-vous à votre compte client FBC Print pour renvoyer le fichier (code : ${order.trackingCode}) : ${trackingLink}`,
    },
    {
      label: 'Paiement validé',
      text: `Bonjour ${order.customerName}, votre paiement pour la commande ${order.orderNumber} est validé ! Connectez-vous à votre espace client FBC Print pour télécharger votre reçu PDF (code : ${order.trackingCode}) : ${trackingLink}`,
    },
    {
      label: 'Commande prête',
      text: `Bonjour ${order.customerName}, bonne nouvelle ! Votre commande ${order.orderNumber} est prête chez FBC Print. Code de suivi : ${order.trackingCode} — ${trackingLink}`,
    },
    {
      label: 'Commande livrée',
      text: `Bonjour ${order.customerName}, votre commande ${order.orderNumber} a bien été remise. Merci pour votre confiance chez FBC Print !`,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="bg-white rounded-3xl max-w-4xl w-full p-5 sm:p-8 shadow-xl space-y-6 my-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-display text-2xl text-[#26547C]">
                {order.orderNumber}
              </h2>
              <span
                className={`px-3 py-1 rounded-full text-xs font-semibold border ${statusMeta.bg} ${statusMeta.text} ${statusMeta.border}`}
              >
                {statusMeta.label}
              </span>
              <span
                className={`px-3 py-1 rounded-full text-xs font-semibold ${paymentMeta.bg} ${paymentMeta.text}`}
              >
                {paymentMeta.label}
              </span>
              {order.urgent && (
                <span className="px-3 py-1 rounded-full text-xs font-bold bg-[#EF233C] text-white">
                  URGENT
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600 mt-1">
              {order.customerName} · {order.customerPhone}{' '}
              {order.isWhatsapp ? '(WhatsApp)' : ''} ·{' '}
              {order.wantsDelivery
                ? `Livraison : ${order.deliveryZoneName} (${order.deliveryAddress})`
                : 'Retrait à l’agence'}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2.5 rounded-full bg-[#EDF2F4] text-slate-600 hover:text-black min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Fermer la fiche"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {actionError && (
          <p className="text-xs font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-2.5 rounded-2xl">
            {actionError}
          </p>
        )}

        {/* Status Transition + Notes */}
        <div className="grid md:grid-cols-2 gap-5">
          <div className="bg-[#EDF2F4]/70 rounded-2xl p-4 space-y-3">
            <h3 className="font-bold text-sm text-[#26547C]">Changer le statut</h3>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value as OrderStatus)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 text-sm min-h-[44px]"
            >
              {ALL_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {ORDER_STATUS_META[st].label}
                </option>
              ))}
            </select>

            {selectedStatus === 'fichier_a_corriger' && (
              <textarea
                rows={2}
                value={correctionMsg}
                onChange={(e) => setCorrectionMsg(e.target.value)}
                placeholder="Motif visible par le client (ex : résolution trop faible sur le logo)..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#EF233C]/40 text-sm"
              />
            )}

            {selectedStatus === 'annulee' && (
              <input
                type="text"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Motif d’annulation..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-slate-300 text-sm"
              />
            )}

            <input
              type="text"
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              placeholder="Note d’historique optionnelle..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 text-sm"
            />

            <button
              type="button"
              disabled={saving}
              onClick={handleStatusSave}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#26547C] text-white text-xs font-semibold hover:bg-[#1e4466] min-h-[44px]"
            >
              <CheckCircle2 className="w-4 h-4" />
              Appliquer le statut
            </button>
          </div>

          <div className="bg-[#EDF2F4]/70 rounded-2xl p-4 space-y-3">
            <h3 className="font-bold text-sm text-[#26547C]">
              Planification &amp; Notes internes (privées)
            </h3>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs text-slate-600 mb-1">
                  Date promise
                </label>
                <input
                  type="date"
                  value={promisedDate}
                  onChange={(e) => setPromisedDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm"
                />
              </div>
              {isAdmin && (
                <div>
                  <label className="block text-xs text-slate-600 mb-1">
                    Remise (FCFA)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={discountAmount}
                    onChange={(e) => setDiscountAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm"
                  />
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold text-[#26547C] cursor-pointer">
              <input
                type="checkbox"
                checked={isUrgent}
                onChange={(e) => setIsUrgent(e.target.checked)}
                className="w-4 h-4 accent-[#EF233C]"
              />
              Marquer cette commande comme urgente
            </label>

            <textarea
              rows={2}
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder="Notes internes d’atelier (invisibles pour le client)..."
              className="w-full px-3.5 py-2 rounded-xl bg-white border border-slate-200 text-sm"
            />

            <button
              type="button"
              disabled={saving}
              onClick={handleMetaSave}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#119DA4] text-white text-xs font-semibold hover:bg-[#0e848a] min-h-[44px]"
            >
              <Save className="w-4 h-4" />
              Enregistrer les infos
            </button>
          </div>
        </div>

        {/* Items & Totals */}
        <div className="border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold text-sm text-[#26547C]">
              Prestations commandées ({order.items.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => generateQuotePdf(order, settings)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold"
              >
                <Download className="w-3.5 h-3.5" />
                Devis PDF
              </button>
              {(order.paymentStatus === 'paye' ||
                order.paymentStatus === 'partiellement_paye') && (
                <button
                  type="button"
                  onClick={() => generateReceiptPdf(order, settings)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#2E9E6B]/15 text-[#237A52] text-xs font-semibold"
                >
                  <Download className="w-3.5 h-3.5" />
                  Reçu PDF
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {order.items.map((item) => {
              const apparelSizeEntries = getNonZeroApparelSizes(item.apparelSizes);
              const jerseySizeEntries = getJerseySizeBreakdown(item.jerseyRows);
              const sizeEntries =
                apparelSizeEntries.length > 0 ? apparelSizeEntries : jerseySizeEntries;

              return (
                <div key={item.itemId} className="py-3 flex justify-between gap-4 text-sm">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[#26547C]">{item.serviceName}</span>
                      <span className="px-2 py-0.5 rounded-full bg-[#EDF2F4] text-[11px] font-bold text-[#26547C] tabular-nums">
                        Total : {item.quantity}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">{item.summaryText}</div>

                    {sizeEntries.length > 0 && (
                      <div className="bg-[#EDF2F4]/80 border border-[#26547C]/15 rounded-xl p-2.5 space-y-1">
                        <div className="text-[11px] font-bold uppercase tracking-wide text-[#26547C]">
                          Détail des quantités par taille
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {sizeEntries.map(([sz, count]) => (
                            <span
                              key={sz}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-xs font-semibold text-[#26547C] tabular-nums"
                            >
                              <span>{sz} :</span>
                              <strong className="text-[#119DA4]">{count}</strong>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {item.notes && (
                      <div className="text-xs text-[#119DA4] mt-0.5">
                        Note client : {item.notes}
                      </div>
                    )}
                    {item.jerseyRows && item.jerseyRows.length > 0 && (
                      <div className="mt-1 text-xs text-slate-500">
                        Flocages :{' '}
                        {item.jerseyRows
                          .map(
                            (r) =>
                              `${r.backName || '-'} #${r.number} (${r.size} ×${r.quantity})`
                          )
                          .join(', ')}
                      </div>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="font-bold tabular-nums shrink-0">
                      {formatFcfa(item.subtotal)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {isAdmin && (
            <div className="pt-2 border-t border-slate-200 flex flex-wrap justify-between items-center gap-3 text-sm">
              <span className="text-slate-600">
                Payé : <strong className="text-[#2E9E6B]">{formatFcfa(order.paidAmount || 0)}</strong>
              </span>
              <span className="text-lg font-bold text-[#26547C] tabular-nums">
                Total : {formatFcfa(order.totalAmount)}
              </span>
            </div>
          )}
        </div>

        {/* Files Section with Technical Preflight & ZIP Download */}
        <div className="border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold text-sm text-[#26547C]">
              Fichiers originaux sans compression ({order.files.length})
            </h3>
            <button
              type="button"
              disabled={zipLoading || order.files.length === 0}
              onClick={handleDownloadAllZip}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#26547C] text-white text-xs font-semibold hover:bg-[#1e4466] min-h-[40px]"
            >
              <Archive className="w-4 h-4" />
              {zipLoading ? 'Création du ZIP...' : 'Tout télécharger (.ZIP)'}
            </button>
          </div>
          {zipError && (
            <p className="text-xs font-medium text-[#EF233C] bg-[#EF233C]/10 px-3 py-2 rounded-xl">
              {zipError}
            </p>
          )}

          <div className="divide-y divide-slate-100">
            {order.files.map((file) => (
              <div
                key={`${file.fileId}_${file.version}`}
                className={`py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  file.replaced ? 'opacity-50' : ''
                }`}
              >
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-sm font-bold text-[#26547C] break-words [overflow-wrap:anywhere]">
                      {file.originalName}
                    </span>
                    <span className="text-xs text-slate-500 shrink-0">
                      v{file.version} {file.replaced ? '(remplacé)' : ''}
                    </span>
                    {file.lowQualityWarning && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                        <AlertTriangle className="w-3 h-3" />
                        DPI faible
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-600 tabular-nums">
                    {file.slotLabel} · {formatBytes(file.sizeBytes)}
                    {file.widthPx && file.heightPx
                      ? ` · ${file.widthPx}×${file.heightPx} px`
                      : ''}
                    {file.widthCm && file.heightCm
                      ? ` · ${file.widthCm}×${file.heightCm} cm`
                      : ''}
                    {file.estimatedDpi ? ` · ~${file.estimatedDpi} DPI` : ''}
                    {file.colorSpace ? ` · ${file.colorSpace}` : ''}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 truncate max-w-md">
                    SHA-256 : {file.sha256}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {file.previewAvailable ? (
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewFile({
                          fileId: file.fileId,
                          name: file.originalName,
                          ext: file.extension,
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:bg-[#119DA4]/15 min-h-[40px]"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Aperçu
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400 inline-flex items-center gap-1">
                      <FileWarning className="w-3.5 h-3.5" />
                      Source brute
                    </span>
                  )}

                  <button
                    type="button"
                    disabled={downloadingFileId === file.fileId}
                    onClick={async () => {
                      setDownloadingFileId(file.fileId);
                      setActionError(null);
                      try {
                        await triggerStaffProtectedDownload(
                          `/api/files/${file.fileId}/download`,
                          file.originalName
                        );
                      } catch (err) {
                        setActionError(
                          err instanceof Error
                            ? err.message
                            : 'Impossible de télécharger ce fichier.'
                        );
                      } finally {
                        setDownloadingFileId(null);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#119DA4] text-white text-xs font-semibold hover:bg-[#0e848a] min-h-[40px] disabled:opacity-60"
                  >
                    {downloadingFileId === file.fileId ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    Original
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* WhatsApp Message Templates */}
        <div className="border border-slate-200 rounded-2xl p-4 space-y-3">
          <h3 className="font-bold text-sm text-[#26547C] flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-[#119DA4]" />
            Contacter le client sur WhatsApp (modèles rapides)
          </h3>
          <div className="flex flex-wrap gap-2">
            {messageTemplates.map((tpl) => (
              <a
                key={tpl.label}
                href={`https://wa.me/${whatsappClean}?text=${encodeURIComponent(tpl.text)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:bg-[#26547C] hover:text-white transition-colors min-h-[38px] inline-flex items-center"
              >
                {tpl.label}
              </a>
            ))}
          </div>
        </div>

        {/* Audit History */}
        <div className="space-y-2">
          <h3 className="font-bold text-sm text-[#26547C]">Historique horodaté</h3>
          <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 text-xs">
            {[...order.statusHistory].reverse().map((h, i) => (
              <div key={`${h.timestamp}_${i}`} className="py-1.5 flex justify-between gap-3">
                <div>
                  <strong className="text-[#26547C]">{h.label}</strong> ·{' '}
                  <span className="text-slate-600">{h.actor}</span>
                  {h.note ? ` — ${h.note}` : ''}
                </div>
                <span className="text-slate-400 tabular-nums shrink-0">
                  {new Date(h.timestamp).toLocaleString('fr-FR')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Inline File Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-3xl w-full p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm text-[#26547C] truncate">
                {previewFile.name}
              </span>
              <button
                type="button"
                onClick={() => setPreviewFile(null)}
                className="p-2 rounded-full bg-[#EDF2F4] text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {previewLoading ? (
              <div className="py-16 text-center space-y-2 text-slate-600">
                <Loader2 className="w-8 h-8 animate-spin text-[#119DA4] mx-auto" />
                <p className="text-sm">Chargement sécurisé de l’aperçu...</p>
              </div>
            ) : previewError ? (
              <p className="text-sm text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl text-center">
                {previewError}
              </p>
            ) : previewBlobUrl ? (
              previewFile.ext === '.pdf' ? (
                <iframe
                  src={previewBlobUrl}
                  title={previewFile.name}
                  className="w-full h-[70vh] rounded-2xl border border-slate-200"
                />
              ) : (
                <img
                  src={previewBlobUrl}
                  alt={previewFile.name}
                  className="max-h-[70vh] mx-auto rounded-2xl object-contain"
                />
              )
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
