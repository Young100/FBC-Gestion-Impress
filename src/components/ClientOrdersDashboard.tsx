import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  KeyRound,
  Loader2,
  LogOut,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Volume2,
  VolumeX,
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
import {
  changeClientPassword,
  logoutClientAccount,
} from '../lib/clientApi';
import { formatFcfa } from '../lib/pricing';
import {
  ORDER_STATUS_META,
  PAYMENT_STATUS_META,
  type ClientAccountPublic,
  type Order,
} from '../types/fbc';
import { NotificationPermissionPrompt } from './NotificationPermissionPrompt';
import { useToast } from './ToastProvider';

interface ClientOrdersDashboardProps {
  account: ClientAccountPublic;
  orders: Order[];
  loading: boolean;
  securityNotice?: string | null;
  onRefresh: () => Promise<void> | void;
  onOpenOrder: (order: Order) => void;
  onOpenCode: (trackingCode: string) => Promise<string | null>;
  onStartOrder: () => void;
  onAccountUpdated: (account: ClientAccountPublic) => void;
  onLoggedOut: () => void;
}

type OrderFilterTab = 'all' | 'active' | 'action' | 'done';

export const ClientOrdersDashboard: React.FC<ClientOrdersDashboardProps> = ({
  account,
  orders,
  loading,
  securityNotice = null,
  onRefresh,
  onOpenOrder,
  onOpenCode,
  onStartOrder,
  onAccountUpdated,
  onLoggedOut,
}) => {
  const { showToast } = useToast();
  const [filterTab, setFilterTab] = useState<OrderFilterTab>('all');
  const [claimCode, setClaimCode] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [showClaimBox, setShowClaimBox] = useState(false);

  const [showPasswordBox, setShowPasswordBox] = useState(Boolean(account.mustChangePassword));
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

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

  const handleTogglePopups = async () => {
    const current = getBrowserNotifPermission();
    setNotifPermission(current);
    if (current === 'unsupported') return;
    if (current === 'denied') {
      showToast({
        id: 'dash_notif_denied',
        title: 'Notifications bloquées',
        message: 'Autorisez les notifications dans les réglages de votre navigateur.',
        variant: 'warning',
        durationMs: 6000,
      });
      return;
    }
    if (current === 'granted') {
      const next = !browserNotifEnabled;
      setBrowserNotifEnabled(CLIENT_PREF_KEY, next);
      setBrowserNotifEnabledState(next);
      if (next) {
        if (soundEnabled) playNotificationChime('success');
        void dispatchNativeNotification({
          title: 'Alertes FBC Print activées',
          body: 'Vous recevrez un signal sonore et une notification à chaque mise à jour.',
          tag: 'fbc-client-dashboard-alerts',
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          url: '/client/',
          swScope: '/client/',
        });
      }
      return;
    }
    const res = await requestBrowserNotifPermission(CLIENT_PREF_KEY);
    setNotifPermission(res);
    if (res === 'granted') {
      setBrowserNotifEnabledState(true);
      if (soundEnabled) playNotificationChime('success');
      showToast({
        id: 'dash_notif_granted',
        title: 'Alertes sonores et pop-up activées !',
        message: 'Vous serez notifié en temps réel pour toutes vos commandes.',
        variant: 'success',
        durationMs: 5000,
      });
    }
  };

  const handleToggleSound = () => {
    const next = !soundEnabled;
    setAudioChimeEnabled(CLIENT_SOUND_KEY, next);
    setSoundEnabledState(next);
    if (next) playNotificationChime('info');
  };

  const handleClaimOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setClaimError(null);
    const trimmed = claimCode.trim().toUpperCase();
    if (!trimmed) {
      setClaimError('Saisissez un code de suivi (ex : FBC-A7K9M2).');
      return;
    }
    setClaiming(true);
    try {
      const err = await onOpenCode(trimmed);
      if (err) {
        setClaimError(err);
      } else {
        setClaimCode('');
        setShowClaimBox(false);
      }
    } finally {
      setClaiming(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdError(null);
    if (!currentPwd || newPwd.trim().length < 6) {
      setPwdError('Renseignez votre mot de passe actuel et un nouveau mot de passe (6 car. min).');
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError('Les nouveaux mots de passe ne correspondent pas.');
      return;
    }
    setPwdSaving(true);
    try {
      const updated = await changeClientPassword(currentPwd, newPwd);
      onAccountUpdated(updated);
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setShowPasswordBox(false);
      showToast({
        id: 'cli_pwd_changed',
        title: 'Mot de passe mis à jour',
        message: 'Votre nouveau mot de passe a bien été enregistré.',
        variant: 'success',
        durationMs: 4500,
      });
    } catch (err) {
      setPwdError(
        err instanceof Error ? err.message : 'Impossible de modifier le mot de passe.'
      );
    } finally {
      setPwdSaving(false);
    }
  };

  const handleLogout = async () => {
    await logoutClientAccount();
    onLoggedOut();
  };

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (filterTab === 'active') {
        return o.status !== 'livree' && o.status !== 'annulee';
      }
      if (filterTab === 'action') {
        return (
          o.status === 'fichier_a_corriger' ||
          o.paymentStatus === 'non_paye' ||
          o.paymentStatus === 'rejete' ||
          (o.status !== 'annulee' && o.paidAmount < o.totalAmount && o.paymentStatus !== 'en_attente_validation')
        );
      }
      if (filterTab === 'done') {
        return o.status === 'livree' || o.status === 'annulee';
      }
      return true;
    });
  }, [orders, filterTab]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <NotificationPermissionPrompt
        mode="client"
        permission={notifPermission}
        dismissed={promptDismissed}
        onEnable={() => void handleTogglePopups()}
        onDismiss={() => {
          setPromptDismissed(true);
          try {
            window.sessionStorage.setItem('fbc_client_notif_prompt_dismissed', '1');
          } catch {
            // Ignore storage error
          }
        }}
      />

      {/* Account Header */}
      <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#119DA4]/10 text-[#0E7F85] text-xs font-semibold">
              <ShieldCheck className="w-3.5 h-3.5" />
              Espace client privé · @{account.username}
            </div>
            <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
              Bonjour, {account.fullName}
            </h1>
            <p className="text-sm text-slate-600 tabular-nums">
              Téléphone enregistré : <strong className="text-black">{account.phone}</strong>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {notifPermission !== 'unsupported' && (
              <button
                type="button"
                onClick={() => void handleTogglePopups()}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-xs sm:text-sm font-semibold min-h-[44px] transition-colors ${
                  browserNotifEnabled && notifPermission === 'granted'
                    ? 'bg-[#2E9E6B]/15 text-[#237A52]'
                    : 'bg-[#119DA4] text-white hover:bg-[#0e848a]'
                }`}
              >
                <BellRing className="w-4 h-4 shrink-0" />
                {browserNotifEnabled && notifPermission === 'granted'
                  ? 'Alertes actives'
                  : 'Activer alertes'}
              </button>
            )}

            <button
              type="button"
              onClick={handleToggleSound}
              className={`p-2.5 rounded-full min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors ${
                soundEnabled
                  ? 'bg-[#EDF2F4] text-[#26547C]'
                  : 'bg-slate-100 text-slate-400'
              }`}
              title={soundEnabled ? 'Son activé' : 'Son coupé'}
              aria-label={soundEnabled ? 'Couper le son' : 'Activer le son'}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => setShowPasswordBox((v) => !v)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs sm:text-sm font-semibold hover:bg-[#26547C]/10 min-h-[44px]"
            >
              <KeyRound className="w-4 h-4" />
              Mot de passe
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-slate-200 text-slate-600 text-xs sm:text-sm font-medium hover:text-[#EF233C] hover:border-[#EF233C]/40 min-h-[44px]"
            >
              <LogOut className="w-4 h-4" />
              Déconnexion
            </button>
          </div>
        </div>

        {account.mustChangePassword && (
          <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <strong>Mot de passe temporaire actif.</strong> Veuillez définir votre propre mot de passe personnel ci-dessous.
            </div>
          </div>
        )}

        {showPasswordBox && (
          <form
            onSubmit={handleChangePassword}
            className="p-4 sm:p-5 rounded-2xl bg-[#EDF2F4] border border-slate-200 space-y-3.5"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#26547C]">
                Modifier mon mot de passe
              </h3>
              <button
                type="button"
                onClick={() => setShowPasswordBox(false)}
                className="text-xs font-medium text-slate-500 hover:text-[#26547C]"
              >
                Fermer
              </button>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <input
                type="password"
                value={currentPwd}
                onChange={(e) => setCurrentPwd(e.target.value)}
                placeholder="Mot de passe actuel"
                className="px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 text-sm min-h-[42px]"
              />
              <input
                type="password"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                placeholder="Nouveau (min. 6 car.)"
                className="px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 text-sm min-h-[42px]"
              />
              <input
                type="password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                placeholder="Confirmer"
                className="px-3.5 py-2.5 rounded-xl bg-white border border-slate-200 text-sm min-h-[42px]"
              />
            </div>
            {pwdError && (
              <p className="text-xs font-medium text-[#EF233C]">{pwdError}</p>
            )}
            <button
              type="submit"
              disabled={pwdSaving}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#26547C] text-white text-xs sm:text-sm font-semibold min-h-[42px]"
            >
              {pwdSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              Enregistrer le nouveau mot de passe
            </button>
          </form>
        )}
      </div>

      {/* Unified Quick Tracking / Claim Bar + Filters */}
      {securityNotice && (
        <div className="text-xs sm:text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 border border-[#EF233C]/25 px-4 py-3 rounded-2xl">
          {securityNotice}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: 'all', label: `Toutes (${orders.length})` },
              {
                id: 'active',
                label: `En cours (${orders.filter((o) => o.status !== 'livree' && o.status !== 'annulee').length})`,
              },
              { id: 'action', label: 'Action requise' },
              { id: 'done', label: 'Terminées' },
            ] as Array<{ id: OrderFilterTab; label: string }>
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilterTab(t.id)}
              className={`px-4 py-2 rounded-full text-xs sm:text-sm font-semibold transition-colors min-h-[40px] ${
                filterTab === t.id
                  ? 'bg-[#26547C] text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:text-[#26547C]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowClaimBox((v) => !v)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-slate-200 text-[#26547C] text-xs sm:text-sm font-semibold hover:border-[#119DA4] min-h-[42px]"
          >
            <Search className="w-4 h-4 text-[#119DA4]" />
            Suivre par code
          </button>

          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={loading}
            className="p-2.5 rounded-full bg-white border border-slate-200 text-[#26547C] hover:border-[#119DA4] min-h-[42px] min-w-[42px] flex items-center justify-center"
            title="Actualiser mes commandes"
            aria-label="Actualiser mes commandes"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={onStartOrder}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#EF233C] text-white text-xs sm:text-sm font-semibold hover:bg-[#d81b32] min-h-[42px]"
          >
            <Plus className="w-4 h-4" />
            Nouvelle commande
          </button>
        </div>
      </div>

      {showClaimBox && (
        <form
          onSubmit={handleClaimOrder}
          className="bg-white rounded-2xl p-4 sm:p-5 border border-[#119DA4]/30 shadow-sm space-y-3"
        >
          <div className="text-sm font-bold text-[#26547C]">
            Suivre ou rattacher une commande via son code
          </div>
          <p className="text-xs text-slate-600">
            Saisissez un code de suivi (ex : FBC-A7K9M2) pour l’ouvrir directement ou rattacher une commande passée en atelier au numéro <strong className="text-black">{account.phone}</strong>.
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              value={claimCode}
              onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
              placeholder="Ex : FBC-A7K9M2"
              className="flex-1 px-4 py-2.5 rounded-xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-sm font-mono uppercase min-h-[44px]"
            />
            <button
              type="submit"
              disabled={claiming}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[#119DA4] text-white text-sm font-semibold hover:bg-[#0e848a] min-h-[44px]"
            >
              {claiming && <Loader2 className="w-4 h-4 animate-spin" />}
              Ouvrir le suivi
            </button>
          </div>
          {claimError && (
            <p className="text-xs font-medium text-[#EF233C]">{claimError}</p>
          )}
        </form>
      )}

      {/* Orders List */}
      {loading && orders.length === 0 ? (
        <div className="bg-white rounded-3xl p-12 border border-slate-200 text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-[#119DA4] mx-auto" />
          <p className="text-sm text-slate-600">Chargement de vos commandes...</p>
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="bg-white rounded-3xl p-10 border border-slate-200 text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-[#EDF2F4] text-[#26547C] flex items-center justify-center mx-auto">
            <Package className="w-7 h-7" />
          </div>
          <div className="space-y-1">
            <h2 className="font-display text-xl text-[#26547C]">
              {orders.length === 0
                ? 'Aucune commande enregistrée pour le moment'
                : 'Aucune commande dans ce filtre'}
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              {orders.length === 0
                ? 'Passez votre première commande d’impression en ligne ou rattachez une commande déjà créée en atelier.'
                : 'Changez de filtre pour afficher vos autres commandes.'}
            </p>
          </div>
          {orders.length === 0 && (
            <button
              type="button"
              onClick={onStartOrder}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[#EF233C] text-white text-sm font-semibold hover:bg-[#d81b32] min-h-[44px]"
            >
              <Plus className="w-4 h-4" />
              Passer ma première commande
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredOrders.map((o) => {
            const st = ORDER_STATUS_META[o.status] || ORDER_STATUS_META.recue;
            const pay = PAYMENT_STATUS_META[o.paymentStatus] || PAYMENT_STATUS_META.non_paye;
            const needsFileFix = o.status === 'fichier_a_corriger';
            const remaining = Math.max(0, o.totalAmount - (o.paidAmount || 0));
            const createdDate = o.createdAtIso || (typeof o.createdAt === 'string' ? o.createdAt : '');

            return (
              <div
                key={o.orderId}
                className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200 hover:border-[#119DA4] shadow-sm transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-display text-xl text-[#26547C]">
                      {o.orderNumber}
                    </span>
                    <span className="font-mono text-xs font-semibold px-2.5 py-0.5 rounded-lg bg-[#EDF2F4] text-[#26547C]">
                      {o.trackingCode}
                    </span>
                    <span
                      className={`px-3 py-0.5 rounded-full text-xs font-semibold border ${st.bg} ${st.text} ${st.border}`}
                    >
                      {st.label}
                    </span>
                    <span className={`px-3 py-0.5 rounded-full text-xs font-semibold ${pay.bg} ${pay.text}`}>
                      {pay.label}
                    </span>
                  </div>

                  <p className="text-sm text-slate-600 line-clamp-2">
                    {o.items.map((i) => `${i.serviceName} (×${i.quantity})`).join(' · ')}
                  </p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    {createdDate && (
                      <span>
                        Créée le {new Date(createdDate).toLocaleDateString('fr-FR')}
                      </span>
                    )}
                    <span className="tabular-nums">
                      Total : <strong className="text-black">{formatFcfa(o.totalAmount)}</strong>
                    </span>
                    {remaining > 0 && o.status !== 'annulee' && (
                      <span className="tabular-nums text-[#EF233C] font-semibold">
                        Reste à payer : {formatFcfa(remaining)}
                      </span>
                    )}
                  </div>

                  {needsFileFix && (
                    <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#EF233C]">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Action requise : renvoyez un fichier corrigé
                    </div>
                  )}
                </div>

                <div className="shrink-0">
                  <button
                    type="button"
                    onClick={() => onOpenOrder(o)}
                    className="w-full md:w-auto inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full bg-[#26547C] text-white text-sm font-semibold hover:bg-[#1e4466] transition-colors min-h-[44px]"
                  >
                    Ouvrir le suivi
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
