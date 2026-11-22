import React, { useState } from 'react';
import {
  AlertCircle,
  BellRing,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  MessageCircle,
  Search,
  UploadCloud,
  Volume2,
  VolumeX,
  Wallet,
} from 'lucide-react';
import {
  CLIENT_PREF_KEY,
  CLIENT_SOUND_KEY,
  dispatchNativeNotification,
  getBrowserNotifPermission,
  isAudioChimeEnabled,
  isBrowserNotifEnabled,
  playNotificationChime,
  requestBrowserNotifPermission,
  setAudioChimeEnabled,
  setBrowserNotifEnabled,
  type BrowserNotifPermission,
} from '../lib/browserNotifications';
import { reuploadCorrectedFile } from '../lib/firestoreApi';
import { generateQuotePdf, generateReceiptPdf } from '../lib/pdfGenerator';
import {
  formatBytes,
  formatFcfa,
  getJerseySizeBreakdown,
  getNonZeroApparelSizes,
} from '../lib/pricing';
import { startResumableUpload } from '../lib/uploadClient';
import {
  ORDER_STATUS_META,
  PAYMENT_STATUS_META,
  type Order,
  type PaymentMethod,
  type ShopSettings,
} from '../types/fbc';
import { NotificationPermissionPrompt } from './NotificationPermissionPrompt';
import { PaymentDeclarationPanel } from './PaymentDeclarationPanel';
import { useToast } from './ToastProvider';

interface OrderTrackingViewProps {
  order: Order | null;
  settings: ShopSettings;
  paymentMethods: PaymentMethod[];
  onLookup: (orderNumber: string, phone: string) => Promise<string | null>;
  onResetOrder: () => void;
}

const TIMELINE_STEPS = [
  { key: 'recue', label: 'Reçue' },
  { key: 'paiement', label: 'Paiement confirmé' },
  { key: 'en_production', label: 'En production' },
  { key: 'prete', label: 'Prête' },
  { key: 'livree', label: 'Livrée' },
];

export const OrderTrackingView: React.FC<OrderTrackingViewProps> = ({
  order,
  settings,
  paymentMethods,
  onLookup,
  onResetOrder,
}) => {
  const { showToast } = useToast();
  const [orderNumber, setOrderNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [reuploadingSlot, setReuploadingSlot] = useState<string | null>(null);
  const [reuploadProgress, setReuploadProgress] = useState<number>(0);
  const [reuploadError, setReuploadError] = useState<string | null>(null);
  const [notifPermission, setNotifPermission] = useState<BrowserNotifPermission>(() =>
    getBrowserNotifPermission()
  );
  const [browserNotifEnabled, setBrowserNotifEnabledState] = useState<boolean>(() =>
    isBrowserNotifEnabled(CLIENT_PREF_KEY)
  );
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() =>
    isAudioChimeEnabled(CLIENT_SOUND_KEY)
  );
  const [promptDismissed, setPromptDismissed] = useState<boolean>(() => {
    try {
      return window.sessionStorage.getItem('fbc_client_notif_prompt_dismissed') === '1';
    } catch {
      return false;
    }
  });

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLookupError(null);
    if (!orderNumber.trim() || !phone.trim()) {
      setLookupError('Saisissez votre numéro de commande et votre numéro de téléphone.');
      return;
    }
    setSearching(true);
    try {
      const err = await onLookup(orderNumber, phone);
      if (err) setLookupError(err);
    } finally {
      setSearching(false);
    }
  };

  if (!order) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm space-y-6">
          <div className="text-center space-y-2">
            <img
              src="/assets/aistudio/logo_vertical_1804a5ee.svg"
              alt="FBC Print"
              className="h-24 mx-auto object-contain"
            />
            <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
              Suivi de commande à distance
            </h1>
            <p className="text-sm text-slate-600">
              Retrouvez votre commande sans vous déplacer grâce à votre numéro de commande
              et votre téléphone.
            </p>
          </div>

          <form onSubmit={handleSearch} className="space-y-4">
            <div>
              <label
                htmlFor="track-order-num"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Numéro de commande
              </label>
              <input
                id="track-order-num"
                type="text"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="Ex : CMD-2026-0042"
                className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
              />
            </div>

            <div>
              <label
                htmlFor="track-phone"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Numéro de téléphone / WhatsApp
              </label>
              <input
                id="track-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Ex : +226 74 67 77 08"
                className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
              />
            </div>

            {lookupError && (
              <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
                {lookupError}
              </p>
            )}

            <button
              type="submit"
              disabled={searching}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-4 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] transition-colors min-h-[48px]"
            >
              <Search className="w-5 h-5" />
              {searching ? 'Recherche en cours...' : 'Consulter ma commande'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const statusMeta = ORDER_STATUS_META[order.status];
  const paymentMeta = PAYMENT_STATUS_META[order.paymentStatus];
  const isPaidOrPartial =
    order.paymentStatus === 'paye' || order.paymentStatus === 'partiellement_paye';

  const getStepIndex = () => {
    if (order.status === 'livree') return 4;
    if (order.status === 'prete') return 3;
    if (order.status === 'en_production') return 2;
    if (isPaidOrPartial || order.status === 'payee') return 1;
    return 0;
  };
  const activeStepIndex = getStepIndex();

  const trackingUrl = `${window.location.origin}/client/?track=${encodeURIComponent(order.orderId)}`;
  const whatsappClean = settings.whatsapp.replace(/\D/g, '');
  const whatsappHref = `https://wa.me/${whatsappClean}?text=${encodeURIComponent(
    `Bonjour FBC Print, je souhaite avoir des informations sur ma commande ${order.orderNumber} (code suivi ${order.trackingCode}).`
  )}`;

  const handleCopyTracking = () => {
    navigator.clipboard.writeText(trackingUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
    showToast({
      id: 'tracking_link_copied',
      title: 'Lien privé copié',
      message: 'Conservez ce lien pour suivre votre commande à tout moment.',
      variant: 'info',
      durationMs: 4000,
    });
  };

  const handleToggleClientPopups = async () => {
    const current = getBrowserNotifPermission();
    setNotifPermission(current);

    if (current === 'unsupported') {
      showToast({
        id: 'client_notif_unsupported',
        title: 'Pop-up intégrées actives',
        message:
          'Votre navigateur ne prend pas en charge les notifications système, mais les pop-up à l’écran s’affichent en direct.',
        variant: 'info',
        durationMs: 5500,
      });
      return;
    }

    if (current === 'denied') {
      showToast({
        id: 'client_notif_denied',
        title: 'Notifications bloquées',
        message:
          'Autorisez les notifications dans les réglages du navigateur pour recevoir les alertes hors écran.',
        variant: 'warning',
        durationMs: 7000,
      });
      return;
    }

    if (current === 'granted') {
      const next = !browserNotifEnabled;
      setBrowserNotifEnabled(CLIENT_PREF_KEY, next);
      setBrowserNotifEnabledState(next);
      if (next) {
        if (soundEnabled) playNotificationChime('success');
        showToast({
          id: 'client_notif_enabled',
          badge: order.orderNumber,
          title: 'Alertes pop-up activées',
          message:
            'Vous serez alerté dès que le statut de votre commande évolue.',
          variant: 'success',
          durationMs: 5000,
        });
        void dispatchNativeNotification({
          title: `Suivi ${order.orderNumber} activé`,
          body: 'Vous recevrez une notification à chaque étape (paiement, production, retrait).',
          tag: `fbc-client-welcome-${order.orderId}`,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          url: `/client/?track=${encodeURIComponent(order.orderId)}`,
          swScope: '/client/',
        });
      } else {
        showToast({
          id: 'client_notif_paused',
          title: 'Alertes système en pause',
          message: 'Les pop-up intégrées à la page restent actives.',
          variant: 'info',
          durationMs: 4000,
        });
      }
      return;
    }

    const result = await requestBrowserNotifPermission(CLIENT_PREF_KEY);
    setNotifPermission(result);
    if (result === 'granted') {
      setBrowserNotifEnabledState(true);
      if (soundEnabled) playNotificationChime('success');
      showToast({
        id: 'client_notif_granted',
        badge: order.orderNumber,
        title: 'Alertes pop-up activées !',
        message:
          'Vous serez notifié en temps réel pour votre paiement, la mise en production et le retrait.',
        variant: 'success',
        durationMs: 6000,
      });
      void dispatchNativeNotification({
        title: `Suivi ${order.orderNumber} activé`,
        body: 'Les alertes pop-up sont prêtes pour votre commande FBC Print.',
        tag: `fbc-client-welcome-${order.orderId}`,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        url: `/client/?track=${encodeURIComponent(order.orderId)}`,
        swScope: '/client/',
      });
    } else if (result === 'denied') {
      setBrowserNotifEnabledState(false);
      showToast({
        id: 'client_notif_blocked',
        title: 'Permission refusée',
        message:
          'Seules les notifications pop-up affichées dans cette page seront visibles.',
        variant: 'warning',
        durationMs: 6500,
      });
    }
  };

  const handleToggleClientSound = () => {
    const next = !soundEnabled;
    setAudioChimeEnabled(CLIENT_SOUND_KEY, next);
    setSoundEnabledState(next);
    if (next) playNotificationChime('info');
  };

  const handleReupload = async (oldFileId: string, itemId: string, slotKey: string, slotLabel: string, prevVersion: number, file: File) => {
    setReuploadError(null);
    setReuploadingSlot(oldFileId);
    setReuploadProgress(0);
    try {
      const { promise } = startResumableUpload(
        file,
        {
          itemId,
          slotKey,
          slotLabel,
          version: prevVersion + 1,
        },
        (st) => setReuploadProgress(st.percent)
      );
      const uploaded = await promise;
      await reuploadCorrectedFile(order, oldFileId, uploaded);
      showToast({
        id: `reupload_ok_${oldFileId}`,
        badge: order.orderNumber,
        title: 'Fichier corrigé transmis',
        message: `${uploaded.originalName} a été envoyé à l’atelier pour vérification.`,
        variant: 'success',
        durationMs: 6000,
      });
    } catch (err) {
      setReuploadError(
        err instanceof Error ? err.message : 'Erreur lors du renvoi du fichier.'
      );
    } finally {
      setReuploadingSlot(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <NotificationPermissionPrompt
        mode="client"
        permission={notifPermission}
        dismissed={promptDismissed}
        onEnable={() => void handleToggleClientPopups()}
        onDismiss={() => {
          setPromptDismissed(true);
          try {
            window.sessionStorage.setItem('fbc_client_notif_prompt_dismissed', '1');
          } catch {
            // Ignore storage errors
          }
        }}
      />

      {/* Top Bar */}
      <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
                {order.orderNumber}
              </h1>
              <span
                className={`px-3.5 py-1 rounded-full text-xs font-semibold border ${statusMeta.bg} ${statusMeta.text} ${statusMeta.border}`}
              >
                {statusMeta.label}
              </span>
            </div>
            <p className="text-sm text-slate-600 mt-1">
              Client : <strong className="text-black">{order.customerName}</strong> ·{' '}
              <span className="tabular-nums">{order.customerPhone}</span> · Code :{' '}
              <span className="font-mono font-semibold text-[#26547C]">
                {order.trackingCode}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {notifPermission !== 'unsupported' && (
              <button
                type="button"
                onClick={handleToggleClientPopups}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-sm font-semibold transition-colors min-h-[44px] ${
                  browserNotifEnabled && notifPermission === 'granted'
                    ? 'bg-[#2E9E6B]/15 text-[#237A52] hover:bg-[#2E9E6B]/25'
                    : notifPermission === 'denied'
                      ? 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
                      : 'bg-[#119DA4] text-white hover:bg-[#0e848a]'
                }`}
              >
                <BellRing className="w-4 h-4 shrink-0" />
                {browserNotifEnabled && notifPermission === 'granted'
                  ? 'Alertes pop-up actives'
                  : notifPermission === 'denied'
                    ? 'Pop-up bloquées'
                    : 'Activer les alertes pop-up'}
              </button>
            )}
            <button
              type="button"
              onClick={handleToggleClientSound}
              className={`p-2.5 rounded-full min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors ${
                soundEnabled
                  ? 'bg-[#EDF2F4] text-[#26547C] hover:bg-[#119DA4]/15'
                  : 'bg-slate-100 text-slate-400 hover:text-slate-600'
              }`}
              aria-label={
                soundEnabled ? 'Couper le son des alertes' : 'Activer le son des alertes'
              }
              title={
                soundEnabled ? 'Son des alertes activé' : 'Son des alertes coupé'
              }
            >
              {soundEnabled ? (
                <Volume2 className="w-4 h-4" />
              ) : (
                <VolumeX className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              onClick={handleCopyTracking}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-[#EDF2F4] text-[#26547C] text-sm font-semibold hover:bg-[#26547C]/10 min-h-[44px]"
            >
              {copiedLink ? <Check className="w-4 h-4 text-[#2E9E6B]" /> : <Copy className="w-4 h-4" />}
              {copiedLink ? 'Lien copié' : 'Copier le lien privé'}
            </button>
            <button
              type="button"
              onClick={onResetOrder}
              className="px-4 py-2.5 rounded-full border border-slate-200 text-slate-600 text-sm font-medium hover:text-[#26547C] min-h-[44px]"
            >
              Autre commande
            </button>
          </div>
        </div>

        {/* Visual Progress Timeline */}
        {order.status !== 'annulee' ? (
          <div className="pt-2">
            <div className="grid grid-cols-5 gap-2">
              {TIMELINE_STEPS.map((step, idx) => {
                const done = idx <= activeStepIndex;
                return (
                  <div key={step.key} className="flex flex-col items-center text-center gap-2">
                    <div className="w-full flex items-center">
                      <div
                        className={`h-1.5 flex-1 rounded-l-full ${
                          idx === 0
                            ? 'bg-transparent'
                            : done
                              ? 'bg-[#119DA4]'
                              : 'bg-slate-200'
                        }`}
                      />
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold transition-colors ${
                          done
                            ? 'bg-[#119DA4] text-white'
                            : 'bg-slate-200 text-slate-500'
                        }`}
                      >
                        {done ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                      </div>
                      <div
                        className={`h-1.5 flex-1 rounded-r-full ${
                          idx === TIMELINE_STEPS.length - 1
                            ? 'bg-transparent'
                            : idx < activeStepIndex
                              ? 'bg-[#119DA4]'
                              : 'bg-slate-200'
                        }`}
                      />
                    </div>
                    <span
                      className={`text-xs font-medium leading-tight ${
                        done ? 'text-[#26547C]' : 'text-slate-500'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-2xl bg-slate-100 border border-slate-300 text-sm text-slate-700">
            <strong>Commande annulée.</strong>{' '}
            {order.cancellationReason && `Motif : ${order.cancellationReason}`}
          </div>
        )}

        {/* File Correction Request Alert */}
        {order.status === 'fichier_a_corriger' && (
          <div className="p-5 rounded-2xl bg-[#EF233C]/10 border border-[#EF233C]/30 space-y-2">
            <div className="flex items-center gap-2 text-[#EF233C] font-bold text-base">
              <AlertCircle className="w-5 h-5 shrink-0" />
              Action requise : fichier à corriger
            </div>
            <p className="text-sm text-slate-800">
              {order.correctionRequestMessage ||
                'L’imprimeur demande une nouvelle version de votre fichier ci-dessous.'}
            </p>
          </div>
        )}

        {/* Payment Rejection Alert */}
        {order.paymentStatus === 'rejete' && (
          <div className="p-5 rounded-2xl bg-[#EF233C]/10 border border-[#EF233C]/30 space-y-1">
            <div className="font-bold text-sm text-[#EF233C]">
              Justificatif de paiement rejeté
            </div>
            <p className="text-sm text-slate-800">
              Motif : {order.paymentRejectionReason || 'Capture illisible ou montant non conforme.'}
            </p>
          </div>
        )}

        {/* Actions Grid */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => generateQuotePdf(order, settings)}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-[#26547C] text-white font-semibold text-sm hover:bg-[#1e4466] min-h-[44px]"
          >
            <Download className="w-4 h-4" />
            Télécharger le devis PDF
          </button>

          {isPaidOrPartial && (
            <button
              type="button"
              onClick={() => generateReceiptPdf(order, settings)}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-[#2E9E6B] text-white font-semibold text-sm hover:bg-[#248257] min-h-[44px]"
            >
              <FileText className="w-4 h-4" />
              Télécharger le reçu PDF
            </button>
          )}

          {order.status !== 'annulee' &&
            order.paymentStatus !== 'paye' &&
            order.paymentStatus !== 'en_attente_validation' && (
              <button
                type="button"
                onClick={() => setShowPaymentForm(true)}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#EF233C] text-white font-semibold text-sm hover:bg-[#d81b32] min-h-[44px]"
              >
                <Wallet className="w-4 h-4" />
                {order.paidAmount > 0 ? 'Payer le solde' : 'Déclarer un paiement'}
              </button>
            )}

          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-full border-2 border-[#119DA4] text-[#26547C] font-semibold text-sm hover:bg-[#119DA4]/10 min-h-[44px]"
          >
            <MessageCircle className="w-4 h-4 text-[#119DA4]" />
            Contacter l’agence (WhatsApp)
          </a>
        </div>
      </div>

      {/* Payment Form if opened */}
      {showPaymentForm && (
        <PaymentDeclarationPanel
          order={order}
          paymentMethods={paymentMethods}
          settings={settings}
          onSuccess={() => setShowPaymentForm(false)}
          onCancel={() => setShowPaymentForm(false)}
        />
      )}

      {/* Payment & Financials Summary */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-lg text-[#26547C]">Paiement &amp; Montants</h2>
            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${paymentMeta.bg} ${paymentMeta.text}`}>
              {paymentMeta.label}
            </span>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-600">Total commande</span>
              <span className="font-bold text-black tabular-nums">
                {formatFcfa(order.totalAmount)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Déjà validé</span>
              <span className="font-semibold text-[#2E9E6B] tabular-nums">
                {formatFcfa(order.paidAmount || 0)}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-slate-100">
              <span className="font-semibold text-[#26547C]">Reste à payer</span>
              <span className="font-bold text-[#EF233C] tabular-nums">
                {formatFcfa(Math.max(0, order.totalAmount - (order.paidAmount || 0)))}
              </span>
            </div>
          </div>

          {order.latestPayment && (
            <div className="bg-[#EDF2F4] rounded-2xl p-3.5 text-xs text-slate-700 space-y-1">
              <div className="font-semibold text-[#26547C]">
                Dernière déclaration : {order.latestPayment.methodName}
              </div>
              <div>
                Montant : {formatFcfa(order.latestPayment.declaredAmount)} · Dépôt :{' '}
                {order.latestPayment.depositPhone}
              </div>
              {order.latestPayment.transactionRef && (
                <div>Réf : {order.latestPayment.transactionRef}</div>
              )}
            </div>
          )}
        </div>

        {/* Order Lines */}
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
          <h2 className="font-bold text-lg text-[#26547C]">Prestations commandées</h2>
          <div className="divide-y divide-slate-100">
            {order.items.map((item) => {
              const sizeEntries = item.apparelSizes
                ? getNonZeroApparelSizes(item.apparelSizes)
                : item.jerseyRows
                  ? getJerseySizeBreakdown(item.jerseyRows)
                  : [];
              return (
                <div
                  key={item.itemId}
                  className="py-3 first:pt-0 last:pb-0 flex justify-between gap-3 text-sm"
                >
                  <div>
                    <div className="font-semibold text-[#26547C]">{item.serviceName}</div>
                    <div className="text-slate-600 text-xs mt-0.5">{item.summaryText}</div>
                    {sizeEntries.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {sizeEntries.map(([sz, count]) => (
                          <span
                            key={sz}
                            className="px-2 py-0.5 rounded-md bg-[#EDF2F4] text-[11px] font-semibold text-[#26547C] tabular-nums"
                          >
                            {sz} : {count}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="font-bold text-black tabular-nums shrink-0">
                    {formatFcfa(item.subtotal)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Files & Re-upload support */}
      <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
        <h2 className="font-bold text-lg text-[#26547C]">
          Fichiers transmis sans compression ({order.files.filter((f) => !f.replaced).length})
        </h2>
        {reuploadError && (
          <p className="text-sm text-[#EF233C] font-medium">{reuploadError}</p>
        )}
        <div className="divide-y divide-slate-100">
          {order.files.map((file) => (
            <div
              key={`${file.fileId}_${file.version}`}
              className={`py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0 ${
                file.replaced ? 'opacity-50' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#26547C] break-words [overflow-wrap:anywhere]">
                  {file.originalName}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    (v{file.version} {file.replaced ? '· remplacé' : ''})
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 break-words">
                  {file.slotLabel} · {formatBytes(file.sizeBytes)}
                  {file.widthPx && file.heightPx
                    ? ` · ${file.widthPx}×${file.heightPx} px`
                    : ''}
                </div>
              </div>

              {order.status === 'fichier_a_corriger' && !file.replaced && (
                <label className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#EF233C] text-white text-xs font-semibold cursor-pointer hover:bg-[#d81b32] min-h-[44px] shrink-0">
                  <UploadCloud className="w-4 h-4" />
                  {reuploadingSlot === file.fileId
                    ? `Envoi ${reuploadProgress}%...`
                    : 'Renvoyer ce fichier'}
                  <input
                    type="file"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        handleReupload(
                          file.fileId,
                          file.itemId,
                          file.slotKey,
                          file.slotLabel,
                          file.version,
                          f
                        );
                      }
                    }}
                  />
                </label>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* History */}
      <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-3">
        <h2 className="font-bold text-lg text-[#26547C]">Historique de suivi</h2>
        <div className="space-y-2.5">
          {[...order.statusHistory].reverse().map((entry, idx) => (
            <div
              key={`${entry.timestamp}_${idx}`}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-sm py-2 border-b border-slate-100 last:border-0"
            >
              <div>
                <span className="font-semibold text-[#26547C]">{entry.label}</span>
                {entry.note && (
                  <span className="text-slate-600"> — {entry.note}</span>
                )}
              </div>
              <span className="text-xs text-slate-500 tabular-nums shrink-0">
                {new Date(entry.timestamp).toLocaleString('fr-FR')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
