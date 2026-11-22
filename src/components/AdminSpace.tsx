import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  CreditCard,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Menu,
  Plus,
  Search,
  Shield,
  Volume2,
  VolumeX,
  Wallet,
  X,
  XCircle,
} from 'lucide-react';
import {
  clearStaffSessionToken,
  createManualOrderServer,
  fetchAdminBootstrap,
  fetchStaffSession,
  loginWithStaffCredentials,
  logoutStaffSession,
  rejectPaymentServer,
  savePaymentMethodServer,
  validatePaymentServer,
} from '../lib/adminApi';
import {
  adminRejectPayment,
  adminSavePaymentMethod,
  adminValidatePayment,
  createOrderInFirestore,
  ensureDefaultSeedData,
  resolveStaffUser,
  subscribeAdminClients,
  subscribeAdminOrders,
  subscribeAdminPayments,
  subscribeAuditLogs,
} from '../lib/firestoreApi';
import { APPAREL_SIZE_OPTIONS } from '../data/defaults';
import { auth, googleProvider } from '../lib/firebase';
import {
  calculateItemPricing,
  formatApparelSizesText,
  formatFcfa,
  getApparelTypeFromSlug,
  getJerseySizeBreakdown,
  isApparelSlug,
  normalizeBurkinaPhone,
} from '../lib/pricing';
import {
  ORDER_STATUS_META,
  PAYMENT_STATUS_META,
  type AdminUser,
  type AuditLog,
  type ClientProfile,
  type Order,
  type OrderStatus,
  type Payment,
  type PaymentMethod,
  type PrintService,
  type ShopSettings,
} from '../types/fbc';
import { AdminOrderDetailModal } from './AdminOrderDetailModal';
import { AdminSettingsTabs } from './AdminSettingsTabs';
import { DashboardCharts } from './DashboardCharts';
import { NotificationPermissionPrompt } from './NotificationPermissionPrompt';
import { useToast } from './ToastProvider';
import {
  buildAdminChangeAlerts,
  extractAdminSnapshot,
  type AdminSnapshotState,
} from '../lib/adminNotifications';
import {
  ATELIER_PREF_KEY,
  ATELIER_SOUND_KEY,
  dispatchNativeNotification,
  getBrowserNotifPermission,
  initAudioUnlock,
  isAudioChimeEnabled,
  isBrowserNotifEnabled,
  playNotificationChime,
  requestBrowserNotifPermission,
  setAudioChimeEnabled,
  setBrowserNotifEnabled,
  type BrowserNotifPermission,
} from '../lib/browserNotifications';

interface AdminSpaceProps {
  services: PrintService[];
  paymentMethods: PaymentMethod[];
  settings: ShopSettings;
  onReprintOrder: (order: Order) => void;
}

type AdminTab =
  | 'dashboard'
  | 'orders'
  | 'payments'
  | 'services'
  | 'clients'
  | 'stats'
  | 'settings';

export const AdminSpace: React.FC<AdminSpaceProps> = ({
  services,
  paymentMethods,
  settings,
  onReprintOrder,
}) => {
  const [authReady, setAuthReady] = useState(false);
  const [staffUser, setStaffUser] = useState<AdminUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [accessIdInput, setAccessIdInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const navMenuRef = useRef<HTMLDivElement | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [clients, setClients] = useState<ClientProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const { showToast } = useToast();
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);

  const [notifPermission, setNotifPermission] = useState<BrowserNotifPermission>(() =>
    getBrowserNotifPermission()
  );
  const [browserNotifEnabled, setBrowserNotifEnabledState] = useState<boolean>(() =>
    isBrowserNotifEnabled(ATELIER_PREF_KEY)
  );
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() =>
    isAudioChimeEnabled(ATELIER_SOUND_KEY)
  );
  const [promptDismissed, setPromptDismissed] = useState<boolean>(() => {
    try {
      return window.sessionStorage.getItem('fbc_atelier_notif_prompt_dismissed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    return initAudioUnlock();
  }, []);

  const ordersReadyRef = useRef(false);
  const paymentsReadyRef = useRef(false);
  const prevSnapshotRef = useRef<AdminSnapshotState | null>(null);
  const snapshotUidRef = useRef<string | null>(null);

  // Orders filters
  const [orderSearch, setOrderSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<string>('all');

  // Manual order modal
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualServiceId, setManualServiceId] = useState(services[0]?.id || '');
  const [manualQty, setManualQty] = useState(1);
  const [manualSizes, setManualSizes] = useState<Record<string, number>>({
    XS: 0,
    S: 0,
    M: 1,
    L: 0,
    XL: 0,
    XXL: 0,
    Unique: 1,
    Enfant: 0,
  });
  const [manualUrgent, setManualUrgent] = useState(false);
  const [manualNotes, setManualNotes] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // Payment rejection & screenshot modal
  const [rejectTarget, setRejectTarget] = useState<Payment | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [screenshotModalUrl, setScreenshotModalUrl] = useState<string | null>(null);

  // Payment method editor
  const [editingMethod, setEditingMethod] = useState<PaymentMethod | null>(null);

  const handleSignOut = useCallback(async () => {
    setAuthError(null);
    setDataError(null);
    await logoutStaffSession().catch(() => {});
    await signOut(auth).catch(() => {});
    setStaffUser(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user || !user.email) {
        try {
          const session = await fetchStaffSession();
          if (!mounted) return;
          if (session.authenticated && session.user) {
            setAuthError(null);
            setStaffUser(session.user);
          } else {
            setStaffUser(null);
          }
        } catch {
          if (mounted) setStaffUser(null);
        } finally {
          if (mounted) setAuthReady(true);
        }
        return;
      }

      try {
        const resolved = await resolveStaffUser(user.uid, user.email, user.displayName);
        if (!mounted) return;
        if (!resolved) {
          setAuthError(
            `Le compte ${user.email} n’est pas autorisé dans l’espace atelier FBC Print.`
          );
          setStaffUser(null);
        } else {
          setAuthError(null);
          setStaffUser({ ...resolved, authMethod: 'google' });
          if (resolved.role === 'admin') {
            ensureDefaultSeedData();
          }
        }
      } catch (err) {
        if (!mounted) return;
        setAuthError(
          err instanceof Error ? err.message : 'Erreur de vérification du compte.'
        );
        setStaffUser(null);
      } finally {
        if (mounted) setAuthReady(true);
      }
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // 30-minute inactivity auto sign-out
  useEffect(() => {
    if (!staffUser) return;
    let timer = window.setTimeout(() => {
      handleSignOut();
    }, 30 * 60 * 1000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        handleSignOut();
      }, 30 * 60 * 1000);
    };
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [staffUser, handleSignOut]);

  useEffect(() => {
    if (!navMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (navMenuRef.current && !navMenuRef.current.contains(e.target as Node)) {
        setNavMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [navMenuOpen]);

  const refreshCredentialsData = useCallback(async () => {
    try {
      const data = await fetchAdminBootstrap();
      setOrders(Array.isArray(data.orders) ? data.orders : []);
      setPayments(Array.isArray(data.payments) ? data.payments : []);
      setClients(Array.isArray(data.clients) ? data.clients : []);
      setAuditLogs(Array.isArray(data.auditLogs) ? data.auditLogs : []);
      ordersReadyRef.current = true;
      paymentsReadyRef.current = true;
      setDataError(null);
    } catch (err) {
      setDataError(
        err instanceof Error ? err.message : 'Impossible de charger les données atelier.'
      );
    }
  }, []);

  // Subscribe to Firestore collections (Google Auth) or poll server API (credentials Auth)
  useEffect(() => {
    if (!staffUser) {
      ordersReadyRef.current = false;
      paymentsReadyRef.current = false;
      prevSnapshotRef.current = null;
      snapshotUidRef.current = null;
      setOrders([]);
      setPayments([]);
      setClients([]);
      setAuditLogs([]);
      return;
    }

    if (snapshotUidRef.current !== staffUser.uid) {
      ordersReadyRef.current = false;
      paymentsReadyRef.current = false;
      prevSnapshotRef.current = null;
      snapshotUidRef.current = staffUser.uid;
    }

    if (staffUser.authMethod === 'credentials') {
      refreshCredentialsData();
      const intervalId = window.setInterval(refreshCredentialsData, 8000);
      return () => window.clearInterval(intervalId);
    }

    const unsubs = [
      subscribeAdminOrders((nextOrders) => {
        ordersReadyRef.current = true;
        setOrders(nextOrders);
      }),
      subscribeAdminPayments((nextPayments) => {
        paymentsReadyRef.current = true;
        setPayments(nextPayments);
      }),
      subscribeAdminClients(setClients),
    ];
    if (staffUser.role === 'admin') {
      unsubs.push(subscribeAuditLogs(setAuditLogs));
    }
    return () => unsubs.forEach((u) => u());
  }, [staffUser, refreshCredentialsData]);

  // Real-time pop-up notifications for Admin & Operator on incoming orders, payments & file re-uploads
  useEffect(() => {
    if (!staffUser) return;
    if (!ordersReadyRef.current || !paymentsReadyRef.current) return;

    const prev = prevSnapshotRef.current;
    if (!prev) {
      prevSnapshotRef.current = extractAdminSnapshot(orders, payments);
      return;
    }

    const alerts = buildAdminChangeAlerts({
      prev,
      nextOrders: orders,
      nextPayments: payments,
      ordersReady: ordersReadyRef.current,
      paymentsReady: paymentsReadyRef.current,
      staffRole: staffUser.role,
      staffEmail: staffUser.email,
      onOpenOrder: (orderId) => setSelectedOrderId(orderId),
      onOpenPaymentsTab: () => setActiveTab('payments'),
    });

    prevSnapshotRef.current = extractAdminSnapshot(orders, payments);

    if (alerts.length === 0) return;

    if (soundEnabled) {
      const hasUrgent = alerts.some(
        (a) => a.toast.variant === 'error' || a.toast.variant === 'warning'
      );
      playNotificationChime(hasUrgent ? 'warning' : 'info');
    }

    for (const alert of alerts) {
      showToast(alert.toast);
      if (browserNotifEnabled && getBrowserNotifPermission() === 'granted') {
        void dispatchNativeNotification({
          title: alert.nativeTitle,
          body: alert.nativeBody,
          tag: alert.nativeTag,
          icon: '/atelier-192x192.png',
          badge: '/atelier-192x192.png',
          url: alert.nativeUrl,
          swScope: '/fbcprintgestionadmin/',
          requireInteraction: alert.requireInteraction,
        });
      }
    }
  }, [orders, payments, staffUser, showToast, soundEnabled, browserNotifEnabled]);

  const handleToggleBrowserPopups = async () => {
    const currentPerm = getBrowserNotifPermission();
    setNotifPermission(currentPerm);

    if (currentPerm === 'unsupported') {
      showToast({
        id: 'atelier_notif_unsupported',
        title: 'Pop-up navigateur indisponibles',
        message:
          'Votre navigateur actuel ne supporte pas les notifications système, mais les alertes pop-up intégrées restent actives.',
        variant: 'info',
        durationMs: 6000,
      });
      return;
    }

    if (currentPerm === 'denied') {
      showToast({
        id: 'atelier_notif_denied',
        title: 'Notifications bloquées',
        message:
          'Autorisez les notifications pour ce site dans les paramètres de votre navigateur (icône cadenas à côté de l’adresse).',
        variant: 'warning',
        durationMs: 8000,
      });
      return;
    }

    if (currentPerm === 'granted') {
      const next = !browserNotifEnabled;
      setBrowserNotifEnabled(ATELIER_PREF_KEY, next);
      setBrowserNotifEnabledState(next);
      if (next) {
        if (soundEnabled) playNotificationChime('success');
        showToast({
          id: 'atelier_notif_on',
          title: 'Alertes pop-up activées',
          message:
            'Vous recevrez les notifications même lorsque l’application est en arrière-plan.',
          variant: 'success',
          durationMs: 5000,
        });
        void dispatchNativeNotification({
          title: 'FBC Atelier — Alertes actives',
          body: 'Les pop-up temps réel pour les commandes et paiements sont activées.',
          tag: 'fbc-atelier-test',
          icon: '/atelier-192x192.png',
          badge: '/atelier-192x192.png',
          url: '/fbcprintgestionadmin/',
          swScope: '/fbcprintgestionadmin/',
        });
      } else {
        showToast({
          id: 'atelier_notif_muted',
          title: 'Alertes système en pause',
          message:
            'Seules les notifications pop-up dans l’application resteront affichées.',
          variant: 'info',
          durationMs: 4500,
        });
      }
      return;
    }

    const result = await requestBrowserNotifPermission(ATELIER_PREF_KEY);
    setNotifPermission(result);
    if (result === 'granted') {
      setBrowserNotifEnabledState(true);
      if (soundEnabled) playNotificationChime('success');
      showToast({
        id: 'atelier_notif_granted',
        title: 'Alertes pop-up activées !',
        message:
          'Nouvelles commandes, fichiers corrigés et paiements à vérifier s’afficheront en pop-up.',
        variant: 'success',
        durationMs: 6000,
      });
      void dispatchNativeNotification({
        title: 'FBC Atelier — Alertes activées',
        body: 'Vous recevrez désormais les notifications en temps réel.',
        tag: 'fbc-atelier-welcome',
        icon: '/atelier-192x192.png',
        badge: '/atelier-192x192.png',
        url: '/fbcprintgestionadmin/',
        swScope: '/fbcprintgestionadmin/',
      });
    } else if (result === 'denied') {
      setBrowserNotifEnabledState(false);
      showToast({
        id: 'atelier_notif_blocked',
        title: 'Permission refusée',
        message:
          'Les notifications navigateur ont été refusées. Les pop-up intégrées à l’atelier restent actives.',
        variant: 'warning',
        durationMs: 7000,
      });
    }
  };

  const handleToggleSound = () => {
    const next = !soundEnabled;
    setAudioChimeEnabled(ATELIER_SOUND_KEY, next);
    setSoundEnabledState(next);
    if (next) {
      playNotificationChime('info');
    }
    showToast({
      id: 'atelier_sound_toggle',
      title: next ? 'Son des alertes activé' : 'Son des alertes coupé',
      message: next
        ? 'Un signal sonore discret accompagnera les nouvelles alertes atelier.'
        : 'Les alertes pop-up resteront silencieuses.',
      variant: 'info',
      durationMs: 3500,
    });
  };

  const handleCredentialSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const cleanId = accessIdInput.trim().toUpperCase();
    if (!cleanId || !passwordInput) {
      setAuthError('Saisissez votre identifiant unique et votre mot de passe.');
      return;
    }
    setSigningIn(true);
    try {
      if (auth.currentUser) {
        await signOut(auth).catch(() => {});
      }
      const user = await loginWithStaffCredentials(cleanId, passwordInput);
      setPasswordInput('');
      setAuthError(null);
      setDataError(null);
      setStaffUser(user);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Identifiant ou mot de passe incorrect.'
      );
    } finally {
      setSigningIn(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    clearStaffSessionToken();
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Connexion Google annulée ou bloquée.'
      );
    } finally {
      setSigningIn(false);
    }
  };

  // Derived Dashboard Metrics & Alerts
  const metrics = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const monthAgo = new Date(now.getTime() - 30 * 86400000);

    const newCount = orders.filter((o) => o.status === 'recue').length;
    const pendingPaymentsCount = payments.filter(
      (p) => p.status === 'en_attente_validation'
    ).length;
    const inProdCount = orders.filter((o) => o.status === 'en_production').length;
    const readyCount = orders.filter((o) => o.status === 'prete').length;
    const lateCount = orders.filter(
      (o) =>
        o.promisedDeliveryDate &&
        o.promisedDeliveryDate < todayStr &&
        o.status !== 'livree' &&
        o.status !== 'annulee'
    ).length;

    let revDay = 0;
    let revWeek = 0;
    let revMonth = 0;
    for (const p of payments) {
      if (p.status !== 'valide') continue;
      const dt = p.validatedAt ? new Date(p.validatedAt) : new Date();
      if (dt.toISOString().slice(0, 10) === todayStr) revDay += p.declaredAmount;
      if (dt >= weekAgo) revWeek += p.declaredAmount;
      if (dt >= monthAgo) revMonth += p.declaredAmount;
    }

    const toProduceToday = orders
      .filter(
        (o) =>
          o.status === 'payee' ||
          o.status === 'en_production' ||
          o.status === 'en_verification'
      )
      .sort((a, b) => {
        if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
        return (a.promisedDeliveryDate || '9999').localeCompare(
          b.promisedDeliveryDate || '9999'
        );
      });

    // Detect duplicate transaction refs or deposit phones in pending payments
    const refCounts: Record<string, number> = {};
    for (const p of payments) {
      if (p.transactionRef) {
        const key = p.transactionRef.trim().toLowerCase();
        refCounts[key] = (refCounts[key] || 0) + 1;
      }
    }

    const alerts: Array<{ id: string; text: string; orderId?: string }> = [];
    for (const o of orders) {
      if (o.files.some((f) => f.lowQualityWarning && !f.replaced)) {
        alerts.push({
          id: `dpi_${o.orderId}`,
          text: `${o.orderNumber} : fichier avec résolution estimée faible`,
          orderId: o.orderId,
        });
      }
    }
    for (const p of payments) {
      if (p.status === 'en_attente_validation' && !p.screenshotPreviewUrl) {
        alerts.push({
          id: `noscr_${p.paymentId}`,
          text: `${p.orderNumber} : paiement déclaré sans capture d’écran`,
          orderId: p.orderId,
        });
      }
      if (
        p.transactionRef &&
        refCounts[p.transactionRef.trim().toLowerCase()] > 1
      ) {
        alerts.push({
          id: `dup_${p.paymentId}`,
          text: `${p.orderNumber} : référence de transaction en doublon (${p.transactionRef})`,
          orderId: p.orderId,
        });
      }
    }

    return {
      newCount,
      pendingPaymentsCount,
      inProdCount,
      readyCount,
      lateCount,
      revDay,
      revWeek,
      revMonth,
      toProduceToday,
      alerts,
    };
  }, [orders, payments]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      if (paymentFilter !== 'all' && o.paymentStatus !== paymentFilter) return false;
      if (orderSearch.trim()) {
        const q = orderSearch.toLowerCase();
        const hit =
          o.orderNumber.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.customerPhone.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [orders, statusFilter, paymentFilter, orderSearch]);

  const selectedOrder = useMemo(
    () => orders.find((o) => o.orderId === selectedOrderId) || null,
    [orders, selectedOrderId]
  );

  const handleCreateManualOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setManualError(null);
    const phoneCheck = normalizeBurkinaPhone(manualPhone);
    if (!manualName.trim() || !phoneCheck.valid) {
      setManualError('Renseignez un nom et un numéro +226 valide.');
      return;
    }
    const srv = services.find((s) => s.id === manualServiceId) || services[0];
    if (!srv) return;
    const isApparel = isApparelSlug(srv.slug);
    const artType = getApparelTypeFromSlug(srv.slug);
    const cleanSizes: Record<string, number> = {};
    let totalSizesQty = 0;
    if (isApparel) {
      for (const sz of APPAREL_SIZE_OPTIONS[artType]) {
        const val = Math.max(0, Math.round(Number(manualSizes[sz]) || 0));
        if (val > 0) {
          cleanSizes[sz] = val;
          totalSizesQty += val;
        }
      }
      if (totalSizesQty <= 0) {
        setManualError('Indiquez la quantité pour au moins une taille.');
        return;
      }
    }
    const effectiveQty = isApparel ? totalSizesQty : manualQty;
    const pricing = calculateItemPricing(srv, {
      quantity: effectiveQty,
      ...(isApparel
        ? {
            apparelType: artType,
            apparelTech: 'dtf',
            apparelDisposition: 'poitrine_gauche',
            apparelSizes: cleanSizes,
          }
        : {}),
    });
    const urgentFee = manualUrgent
      ? Math.round((pricing.subtotal * (settings.urgentSurchargePercent || 25)) / 100)
      : 0;
    const totalAmount = pricing.subtotal + urgentFee;
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + (settings.quoteValidityDays || 15));

    const orderPayload = {
      customerName: manualName.trim(),
      customerPhone: phoneCheck.normalized,
      isWhatsapp: true,
      wantsDelivery: false,
      deliveryFee: 0,
      urgent: manualUrgent,
      urgentFee,
      discountAmount: 0,
      subtotal: pricing.subtotal,
      totalAmount,
      depositRequiredAmount: Math.round(
        (totalAmount * (settings.depositPercent || 70)) / 100
      ),
      paidAmount: 0,
      status: 'recue' as const,
      paymentStatus: 'non_paye' as const,
      acceptedTerms: true,
      quoteValidUntil: validUntil.toISOString(),
      internalNotes: manualNotes.trim(),
      items: [
        {
          itemId: `itm_${Date.now()}`,
          serviceId: srv.id,
          serviceSlug: srv.slug,
          serviceName: srv.name,
          quantity: effectiveQty,
          ...(isApparel
            ? {
                apparelType: artType,
                apparelTech: 'dtf' as const,
                apparelDisposition: 'poitrine_gauche' as const,
                apparelSizes: cleanSizes,
              }
            : {}),
          unitPrice: pricing.unitPrice,
          subtotal: pricing.subtotal,
          summaryText: pricing.summaryText,
        },
      ],
      files: [],
      statusHistory: [],
      source: 'manual_admin' as const,
    };

    try {
      let createdOrderNumber = '';
      if (staffUser?.authMethod === 'credentials') {
        const res = await createManualOrderServer(orderPayload);
        createdOrderNumber = res.orderNumber;
        await refreshCredentialsData();
      } else {
        const created = await createOrderInFirestore(orderPayload);
        createdOrderNumber = created.orderNumber;
      }
      setShowManualModal(false);
      setManualName('');
      setManualPhone('');
      setManualNotes('');
      showToast({
        id: `manual_order_${Date.now()}`,
        badge: createdOrderNumber || undefined,
        title: 'Commande manuelle enregistrée',
        message: `${orderPayload.customerName} · ${srv.name}`,
        variant: 'success',
        durationMs: 6000,
      });
    } catch (err) {
      setManualError(
        err instanceof Error ? err.message : 'Erreur lors de la création de la commande.'
      );
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 p-8">
        <img
          src="/assets/aistudio/logo_vertical_1804a5ee.svg"
          alt="FBC Print"
          className="h-24 animate-pulse"
        />
        <p className="text-sm font-medium text-[#26547C]">
          Chargement de l’espace atelier...
        </p>
      </div>
    );
  }

  // Login Gate
  if (!staffUser) {
    return (
      <div className="fbc-pattern-bg min-h-[75vh] flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl max-w-md w-full p-6 sm:p-8 border border-slate-200 shadow-sm space-y-6">
          <div className="text-center space-y-3">
            <img
              src="/assets/aistudio/logo_vertical_1804a5ee.svg"
              alt="FBC Print"
              className="h-24 mx-auto object-contain"
            />
            <div className="space-y-1">
              <h1 className="font-display text-2xl text-[#26547C]">
                Espace Administrateur &amp; Atelier
              </h1>
              <p className="text-xs sm:text-sm text-slate-600">
                Connectez-vous avec votre identifiant unique et votre mot de passe, ou
                avec le compte Google administrateur.
              </p>
            </div>
          </div>

          {authError && (
            <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 p-3.5 rounded-2xl text-center">
              {authError}
            </p>
          )}

          <form onSubmit={handleCredentialSignIn} className="space-y-3.5 text-left">
            <div>
              <label
                htmlFor="staff-access-id"
                className="block text-xs font-semibold text-[#26547C] mb-1"
              >
                Identifiant unique atelier
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="staff-access-id"
                  type="text"
                  autoComplete="username"
                  value={accessIdInput}
                  onChange={(e) => setAccessIdInput(e.target.value.toUpperCase())}
                  placeholder="Ex : FBC-OP-7K4M9Q"
                  className="w-full pl-10 pr-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm font-mono uppercase tracking-wide text-[#26547C] focus:outline-none focus:ring-2 focus:ring-[#119DA4] min-h-[46px]"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="staff-password"
                className="block text-xs font-semibold text-[#26547C] mb-1"
              >
                Mot de passe personnalisé
              </label>
              <div className="relative">
                <input
                  id="staff-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Votre mot de passe"
                  className="w-full pl-4 pr-11 py-3 rounded-2xl bg-[#EDF2F4] text-sm text-[#26547C] focus:outline-none focus:ring-2 focus:ring-[#119DA4] min-h-[46px]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-[#26547C] p-1"
                  aria-label={
                    showPassword
                      ? 'Masquer le mot de passe'
                      : 'Afficher le mot de passe'
                  }
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={signingIn}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-full bg-[#119DA4] text-white font-semibold text-sm sm:text-base hover:bg-[#0e848a] transition-colors min-h-[48px] disabled:opacity-60"
            >
              <KeyRound className="w-4 h-4" />
              {signingIn ? 'Vérification...' : 'Se connecter avec mon identifiant'}
            </button>
          </form>

          <div className="relative flex items-center justify-center">
            <span className="h-px bg-slate-200 w-full" />
            <span className="bg-white px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              ou
            </span>
            <span className="h-px bg-slate-200 w-full" />
          </div>

          <div className="space-y-3 text-center">
            <button
              type="button"
              disabled={signingIn}
              onClick={handleGoogleSignIn}
              className="w-full inline-flex items-center justify-center gap-2.5 px-6 py-3 rounded-full bg-[#26547C] text-white font-semibold text-sm hover:bg-[#1e4466] transition-colors min-h-[46px] disabled:opacity-60"
            >
              <Shield className="w-4 h-4" />
              {signingIn ? 'Connexion...' : 'Connexion Google (Admin principal)'}
            </button>

            <a
              href={typeof window !== 'undefined' ? window.location.href : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs font-medium text-[#119DA4] hover:underline"
            >
              Si la fenêtre Google est bloquée, ouvrir dans un nouvel onglet
            </a>
          </div>
        </div>
      </div>
    );
  }

  const isAdmin = staffUser.role === 'admin';
  const notifCount = metrics.newCount + metrics.pendingPaymentsCount;

  const allTabs: Array<{ id: AdminTab; label: string; adminOnly?: boolean }> = [
    { id: 'dashboard', label: 'Tableau de bord' },
    { id: 'orders', label: `Commandes (${orders.length})` },
    {
      id: 'payments',
      label: `Paiements (${metrics.pendingPaymentsCount})`,
      adminOnly: true,
    },
    { id: 'services', label: 'Prestations & Tarifs', adminOnly: true },
    { id: 'clients', label: 'Clients' },
    { id: 'stats', label: 'Statistiques', adminOnly: true },
    { id: 'settings', label: 'Équipe & Réglages', adminOnly: true },
  ];
  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6">
      {/* Staff Top Bar */}
      <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl sm:text-2xl text-[#26547C]">
                Atelier FBC Print
              </h1>
              <span className="px-3 py-0.5 rounded-full text-xs font-semibold bg-[#119DA4]/15 text-[#0E7F85]">
                {isAdmin ? 'Administrateur' : 'Opérateur'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">{staffUser.email}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 self-end md:self-auto relative">
          {/* Pop-up System Notifications Opt-in / Status */}
          {notifPermission !== 'unsupported' && (
            <button
              type="button"
              onClick={handleToggleBrowserPopups}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold transition-colors min-h-[44px] ${
                browserNotifEnabled && notifPermission === 'granted'
                  ? 'bg-[#2E9E6B]/15 text-[#237A52] hover:bg-[#2E9E6B]/25'
                  : notifPermission === 'denied'
                    ? 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
                    : 'bg-[#119DA4]/12 text-[#0E7F85] hover:bg-[#119DA4]/20'
              }`}
              title="Configurer les notifications pop-up système"
            >
              <BellRing className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">
                {browserNotifEnabled && notifPermission === 'granted'
                  ? 'Pop-up actives'
                  : notifPermission === 'denied'
                    ? 'Pop-up bloquées'
                    : 'Activer pop-up'}
              </span>
            </button>
          )}

          {/* Sound Toggle */}
          <button
            type="button"
            onClick={handleToggleSound}
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

          {/* Notification Bell */}
          <button
            type="button"
            onClick={() => setShowNotifications((v) => !v)}
            className="relative p-2.5 rounded-full bg-[#EDF2F4] text-[#26547C] hover:bg-[#119DA4]/15 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Notifications atelier"
          >
            <Bell className="w-5 h-5" />
            {notifCount > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#EF233C] text-white text-[11px] font-bold flex items-center justify-center tabular-nums">
                {notifCount}
              </span>
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 top-14 z-30 w-80 bg-white rounded-2xl border border-slate-200 shadow-lg p-4 space-y-3">
              <div className="font-bold text-sm text-[#26547C]">
                Notifications en attente ({notifCount})
              </div>
              <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto text-xs">
                {orders
                  .filter((o) => o.status === 'recue')
                  .slice(0, 5)
                  .map((o) => (
                    <button
                      key={o.orderId}
                      type="button"
                      onClick={() => {
                        setSelectedOrderId(o.orderId);
                        setShowNotifications(false);
                      }}
                      className="w-full text-left py-2 hover:text-[#119DA4]"
                    >
                      Nouvelle commande <strong>{o.orderNumber}</strong> · {o.customerName}
                      {o.urgent && (
                        <span className="ml-1.5 text-[#EF233C] font-bold">URGENT</span>
                      )}
                    </button>
                  ))}
                {isAdmin &&
                  payments
                    .filter((p) => p.status === 'en_attente_validation')
                    .slice(0, 5)
                    .map((p) => (
                      <button
                        key={p.paymentId}
                        type="button"
                        onClick={() => {
                          setActiveTab('payments');
                          setShowNotifications(false);
                        }}
                        className="w-full text-left py-2 hover:text-[#119DA4]"
                      >
                        Paiement à valider : <strong>{p.orderNumber}</strong> ({p.methodName})
                      </button>
                    ))}
                {notifCount === 0 && (
                  <p className="text-slate-500 py-2">Aucune alerte en attente.</p>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border border-slate-200 text-slate-700 text-xs font-semibold hover:text-[#EF233C] min-h-[44px]"
          >
            <LogOut className="w-4 h-4" />
            Déconnexion
          </button>
        </div>
      </div>

      <NotificationPermissionPrompt
        mode="atelier"
        permission={notifPermission}
        dismissed={promptDismissed}
        onEnable={() => void handleToggleBrowserPopups()}
        onDismiss={() => {
          setPromptDismissed(true);
          try {
            window.sessionStorage.setItem('fbc_atelier_notif_prompt_dismissed', '1');
          } catch {
            // Ignore storage errors
          }
        }}
      />

      {dataError && (
        <div className="bg-[#EF233C]/10 border border-[#EF233C]/25 text-[#EF233C] text-xs font-medium px-4 py-3 rounded-2xl">
          {dataError}
        </div>
      )}

      {/* Navigation Tabs Dropdown */}
      <div ref={navMenuRef} className="relative w-full sm:w-80">
        <button
          type="button"
          onClick={() => setNavMenuOpen((open) => !open)}
          aria-expanded={navMenuOpen}
          aria-haspopup="listbox"
          className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-white border border-slate-200 shadow-sm text-sm font-semibold text-[#26547C] hover:border-[#119DA4] transition-colors min-h-[48px]"
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <Menu className="w-4 h-4 text-[#119DA4] shrink-0" />
            <span className="truncate">
              {tabs.find((t) => t.id === activeTab)?.label || 'Menu atelier'}
            </span>
          </span>
          <ChevronDown
            className={`w-4 h-4 text-slate-500 shrink-0 transition-transform duration-200 ${
              navMenuOpen ? 'rotate-180 text-[#119DA4]' : ''
            }`}
          />
        </button>

        {navMenuOpen && (
          <div
            role="listbox"
            aria-label="Sections de l’espace atelier"
            className="absolute left-0 right-0 mt-2 z-30 bg-white rounded-2xl border border-slate-200 shadow-lg p-1.5 space-y-1"
          >
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setNavMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl text-sm font-semibold text-left transition-colors min-h-[44px] ${
                    active
                      ? 'bg-[#26547C] text-white'
                      : 'text-[#26547C] hover:bg-[#EDF2F4]'
                  }`}
                >
                  <span className="truncate">{tab.label}</span>
                  {active && <Check className="w-4 h-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* TAB: DASHBOARD */}
      {activeTab === 'dashboard' && (
        <div className="space-y-6">
          {/* Modern KPI Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <button
              type="button"
              onClick={() => {
                setStatusFilter('recue');
                setPaymentFilter('all');
                setActiveTab('orders');
              }}
              className="group text-left bg-white rounded-2xl p-5 border border-slate-200 hover:border-[#26547C]/40 transition-colors space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-500">
                <span>Nouvelles</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#26547C] transition-colors" />
              </div>
              <div className="text-3xl font-bold text-[#26547C] tabular-nums">
                {metrics.newCount}
              </div>
              <div className="text-[11px] text-slate-500">À prendre en charge</div>
            </button>

            <button
              type="button"
              onClick={() => {
                if (isAdmin) {
                  setActiveTab('payments');
                } else {
                  setStatusFilter('all');
                  setPaymentFilter('en_attente_validation');
                  setActiveTab('orders');
                }
              }}
              className="group text-left bg-white rounded-2xl p-5 border border-slate-200 hover:border-[#EF233C]/40 transition-colors space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-500">
                <span>Paiements</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#EF233C] transition-colors" />
              </div>
              <div className="text-3xl font-bold text-[#EF233C] tabular-nums">
                {metrics.pendingPaymentsCount}
              </div>
              <div className="text-[11px] text-slate-500">En attente validation</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setStatusFilter('en_production');
                setPaymentFilter('all');
                setActiveTab('orders');
              }}
              className="group text-left bg-white rounded-2xl p-5 border border-slate-200 hover:border-[#119DA4]/40 transition-colors space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-500">
                <span>En production</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#119DA4] transition-colors" />
              </div>
              <div className="text-3xl font-bold text-[#119DA4] tabular-nums">
                {metrics.inProdCount}
              </div>
              <div className="text-[11px] text-slate-500">Impression en cours</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setStatusFilter('prete');
                setPaymentFilter('all');
                setActiveTab('orders');
              }}
              className="group text-left bg-white rounded-2xl p-5 border border-slate-200 hover:border-[#2E9E6B]/40 transition-colors space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-500">
                <span>Prêtes</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#2E9E6B] transition-colors" />
              </div>
              <div className="text-3xl font-bold text-[#2E9E6B] tabular-nums">
                {metrics.readyCount}
              </div>
              <div className="text-[11px] text-slate-500">Retrait ou livraison</div>
            </button>

            <button
              type="button"
              onClick={() => {
                setStatusFilter('all');
                setPaymentFilter('all');
                setActiveTab('orders');
              }}
              className="col-span-2 sm:col-span-1 group text-left bg-white rounded-2xl p-5 border border-slate-200 hover:border-amber-500/40 transition-colors space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-500">
                <span>En retard</span>
                <Clock className="w-3.5 h-3.5 text-amber-500" />
              </div>
              <div className="text-3xl font-bold text-amber-600 tabular-nums">
                {metrics.lateCount}
              </div>
              <div className="text-[11px] text-slate-500">Échéance dépassée</div>
            </button>
          </div>

          {isAdmin && (
            <div className="grid sm:grid-cols-3 gap-4">
              <div className="bg-[#26547C] text-white rounded-2xl p-5 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-white/75">
                    Chiffre d’affaires · Aujourd’hui
                  </div>
                  <div className="text-2xl font-bold mt-1.5 tabular-nums">
                    {formatFcfa(metrics.revDay)}
                  </div>
                </div>
                <Wallet className="w-5 h-5 text-[#119DA4] shrink-0" />
              </div>
              <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-slate-500">
                    Chiffre d’affaires · 7 jours
                  </div>
                  <div className="text-2xl font-bold text-[#26547C] mt-1.5 tabular-nums">
                    {formatFcfa(metrics.revWeek)}
                  </div>
                </div>
                <Wallet className="w-5 h-5 text-[#119DA4] shrink-0" />
              </div>
              <div className="bg-white rounded-2xl p-5 border border-slate-200 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-slate-500">
                    Chiffre d’affaires · 30 jours
                  </div>
                  <div className="text-2xl font-bold text-[#26547C] mt-1.5 tabular-nums">
                    {formatFcfa(metrics.revMonth)}
                  </div>
                </div>
                <Wallet className="w-5 h-5 text-[#2E9E6B] shrink-0" />
              </div>
            </div>
          )}

          {/* Interactive Curve Charts */}
          <DashboardCharts orders={orders} payments={payments} isAdmin={isAdmin} />

          <div className="grid lg:grid-cols-12 gap-6 items-stretch">
            {/* Production Queue */}
            <div className="lg:col-span-7 bg-white rounded-3xl p-6 border border-slate-200 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl text-[#26547C]">
                    À produire aujourd’hui ({metrics.toProduceToday.length})
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Triées par urgence puis par date de livraison promise
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setStatusFilter('all');
                    setPaymentFilter('all');
                    setActiveTab('orders');
                  }}
                  className="text-xs font-semibold text-[#119DA4] hover:underline whitespace-nowrap shrink-0"
                >
                  Tout voir
                </button>
              </div>

              {metrics.toProduceToday.length === 0 ? (
                <p className="text-sm text-slate-500 py-8 text-center">
                  Aucune commande en file d’attente de fabrication.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {metrics.toProduceToday.slice(0, 8).map((o) => (
                    <button
                      key={o.orderId}
                      type="button"
                      onClick={() => setSelectedOrderId(o.orderId)}
                      className="w-full py-3.5 flex items-center justify-between gap-3 text-left hover:bg-[#EDF2F4]/60 rounded-xl px-2.5 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-bold text-[#26547C] tabular-nums">
                            {o.orderNumber}
                          </span>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="font-medium text-slate-800 truncate">
                            {o.customerName}
                          </span>
                          {o.urgent && (
                            <>
                              <span className="text-slate-300" aria-hidden="true">
                                ·
                              </span>
                              <span className="text-xs font-bold text-[#EF233C]">
                                Urgent
                              </span>
                            </>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 truncate">
                          {o.items.map((i) => i.serviceName).join(' · ')}
                        </div>
                      </div>
                      <span
                        className={`text-xs font-semibold shrink-0 whitespace-nowrap ${ORDER_STATUS_META[o.status].text}`}
                      >
                        {ORDER_STATUS_META[o.status].label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Alerts */}
            <div className="lg:col-span-5 bg-white rounded-3xl p-6 border border-slate-200 space-y-4">
              <div>
                <h2 className="font-display text-xl text-[#26547C]">
                  Alertes contrôle atelier
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Vérifications qualité fichiers et justificatifs de paiement
                </p>
              </div>
              {metrics.alerts.length === 0 ? (
                <p className="text-sm text-slate-500 py-8 text-center">
                  Aucune anomalie détectée (DPI, captures ou doublons).
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {metrics.alerts.slice(0, 8).map((al) => (
                    <button
                      key={al.id}
                      type="button"
                      onClick={() => al.orderId && setSelectedOrderId(al.orderId)}
                      className="w-full text-left py-3 px-2.5 rounded-xl hover:bg-[#EF233C]/5 flex items-start gap-2.5 text-xs text-[#26547C] transition-colors"
                    >
                      <AlertTriangle className="w-4 h-4 text-[#EF233C] shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{al.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB: ORDERS */}
      {activeTab === 'orders' && (
        <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 flex-1">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  placeholder="Rechercher CMD-..., nom ou téléphone..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-full bg-[#EDF2F4] text-sm min-h-[44px]"
                />
              </div>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-4 py-2.5 rounded-full bg-[#EDF2F4] text-sm min-h-[44px]"
              >
                <option value="all">Tous statuts</option>
                {(Object.keys(ORDER_STATUS_META) as OrderStatus[]).map((st) => (
                  <option key={st} value={st}>
                    {ORDER_STATUS_META[st].label}
                  </option>
                ))}
              </select>

              <select
                value={paymentFilter}
                onChange={(e) => setPaymentFilter(e.target.value)}
                className="px-4 py-2.5 rounded-full bg-[#EDF2F4] text-sm min-h-[44px]"
              >
                <option value="all">Tous paiements</option>
                <option value="non_paye">Non payé</option>
                <option value="en_attente_validation">En attente validation</option>
                <option value="partiellement_paye">Partiellement payé</option>
                <option value="paye">Payé</option>
                <option value="rejete">Rejeté</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => setShowManualModal(true)}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-[#EF233C] text-white text-sm font-semibold min-h-[44px] shrink-0"
            >
              <Plus className="w-4 h-4" />
              Commande manuelle
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-3 pr-4">Commande</th>
                  <th className="py-3 pr-4">Client</th>
                  <th className="py-3 pr-4">Prestations</th>
                  <th className="py-3 pr-4">Statut</th>
                  <th className="py-3 pr-4">Paiement</th>
                  {isAdmin && <th className="py-3 pr-4 text-right">Total</th>}
                  <th className="py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredOrders.map((o) => {
                  const stMeta = ORDER_STATUS_META[o.status];
                  const pmMeta = PAYMENT_STATUS_META[o.paymentStatus];
                  return (
                    <tr key={o.orderId} className="hover:bg-[#EDF2F4]/40">
                      <td className="py-3.5 pr-4 font-bold text-[#26547C] whitespace-nowrap">
                        {o.orderNumber}
                        {o.urgent && (
                          <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-[#EF233C] text-white">
                            Urgent
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 pr-4">
                        <div className="font-semibold text-black">{o.customerName}</div>
                        <div className="text-xs text-slate-500 tabular-nums">
                          {o.customerPhone}
                        </div>
                      </td>
                      <td className="py-3.5 pr-4 text-xs text-slate-600 max-w-xs">
                        <div className="truncate font-medium text-[#26547C]">
                          {o.items.map((i) => `${i.serviceName} (${i.quantity})`).join(', ')}
                        </div>
                        {o.items.some((i) => i.apparelSizes || i.jerseyRows?.length) && (
                          <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                            {o.items
                              .map((i) => {
                                if (i.apparelSizes) {
                                  const s = formatApparelSizesText(i.apparelSizes);
                                  return s ? `${i.serviceName}: ${s}` : '';
                                }
                                if (i.jerseyRows?.length) {
                                  const js = getJerseySizeBreakdown(i.jerseyRows)
                                    .map(([sz, c]) => `${sz}×${c}`)
                                    .join(', ');
                                  return js ? `${i.serviceName}: ${js}` : '';
                                }
                                return '';
                              })
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-semibold ${stMeta.bg} ${stMeta.text}`}
                        >
                          {stMeta.label}
                        </span>
                      </td>
                      <td className="py-3.5 pr-4 whitespace-nowrap">
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-semibold ${pmMeta.bg} ${pmMeta.text}`}
                        >
                          {pmMeta.label}
                        </span>
                      </td>
                      {isAdmin && (
                        <td className="py-3.5 pr-4 text-right font-bold tabular-nums whitespace-nowrap">
                          {formatFcfa(o.totalAmount)}
                        </td>
                      )}
                      <td className="py-3.5 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setSelectedOrderId(o.orderId)}
                          className="px-4 py-1.5 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold hover:bg-[#26547C] hover:text-white transition-colors min-h-[36px]"
                        >
                          Ouvrir
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filteredOrders.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-slate-500">
                      Aucune commande ne correspond à ces critères.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: PAYMENTS (Admin only) */}
      {activeTab === 'payments' && isAdmin && (
        <div className="space-y-6">
          {/* Validation Queue */}
          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
            <h2 className="font-display text-xl text-[#26547C]">
              Validation des paiements Mobile Money
            </h2>
            <div className="divide-y divide-slate-100">
              {payments.map((pay) => {
                const linkedOrder = orders.find((o) => o.orderId === pay.orderId);
                return (
                  <div
                    key={pay.paymentId}
                    className="py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-[#26547C]">
                          {pay.orderNumber}
                        </span>
                        <span className="text-sm font-semibold">{pay.customerName}</span>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#EDF2F4] text-[#26547C]">
                          {pay.methodName}
                        </span>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            pay.status === 'valide'
                              ? 'bg-[#2E9E6B]/15 text-[#237A52]'
                              : pay.status === 'rejete'
                                ? 'bg-[#EF233C]/15 text-[#EF233C]'
                                : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {pay.status === 'valide'
                            ? 'Validé'
                            : pay.status === 'rejete'
                              ? 'Rejeté'
                              : 'En attente'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 tabular-nums">
                        Montant déclaré :{' '}
                        <strong className="text-black">
                          {formatFcfa(pay.declaredAmount)}
                        </strong>{' '}
                        ({pay.paymentType}) · Dépôt : {pay.depositPhone}
                        {pay.transactionRef ? ` · Réf : ${pay.transactionRef}` : ''}
                      </div>
                      {pay.validatedByEmail && (
                        <div className="text-xs text-slate-400">
                          Traité par {pay.validatedByEmail}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                      {pay.screenshotPreviewUrl && (
                        <button
                          type="button"
                          onClick={() => setScreenshotModalUrl(pay.screenshotPreviewUrl!)}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs font-semibold min-h-[40px]"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Voir capture
                        </button>
                      )}

                      {pay.status === 'en_attente_validation' && linkedOrder && (
                        <>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                if (staffUser.authMethod === 'credentials') {
                                  await validatePaymentServer(pay.paymentId);
                                  await refreshCredentialsData();
                                } else {
                                  await adminValidatePayment({
                                    payment: pay,
                                    order: linkedOrder,
                                    actorEmail: staffUser.email,
                                    actorRole: staffUser.role,
                                  });
                                }
                                showToast({
                                  id: `payment_validated_${pay.paymentId}`,
                                  badge: pay.orderNumber,
                                  title: 'Paiement validé',
                                  message: `${formatFcfa(pay.declaredAmount)} confirmés pour ${pay.customerName}.`,
                                  variant: 'success',
                                  durationMs: 6000,
                                });
                              } catch (err) {
                                setDataError(
                                  err instanceof Error
                                    ? err.message
                                    : 'Impossible de valider ce paiement.'
                                );
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2E9E6B] text-white text-xs font-semibold hover:bg-[#248257] min-h-[40px]"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            Valider
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setRejectTarget(pay);
                              setRejectReason('');
                            }}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#EF233C]/10 text-[#EF233C] text-xs font-semibold hover:bg-[#EF233C] hover:text-white min-h-[40px]"
                          >
                            <XCircle className="w-4 h-4" />
                            Rejeter
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {payments.length === 0 && (
                <p className="text-sm text-slate-500 py-8 text-center">
                  Aucun paiement déclaré pour le moment.
                </p>
              )}
            </div>
          </div>

          {/* Mobile Money Operators Management */}
          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg text-[#26547C]">
                Opérateurs Mobile Money configurés
              </h3>
              <button
                type="button"
                onClick={() =>
                  setEditingMethod({
                    id: `pm_${Date.now()}`,
                    operatorName: '',
                    phoneNumber: '+226 ',
                    accountHolder: 'FBC Print',
                    instructions: '',
                    ussdCode: '',
                    active: true,
                    sortOrder: paymentMethods.length + 1,
                  })
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#119DA4] text-white text-xs font-semibold min-h-[40px]"
              >
                <Plus className="w-4 h-4" />
                Ajouter un opérateur
              </button>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {paymentMethods.map((pm) => (
                <div
                  key={pm.id}
                  className="rounded-2xl p-4 bg-[#EDF2F4]/70 border border-slate-200 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#26547C] flex items-center gap-1.5">
                      <CreditCard className="w-4 h-4 text-[#119DA4]" />
                      {pm.operatorName}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingMethod({ ...pm })}
                      className="text-xs font-semibold text-[#119DA4] hover:underline"
                    >
                      Modifier
                    </button>
                  </div>
                  <div className="text-sm font-bold tabular-nums">{pm.phoneNumber}</div>
                  <div className="text-xs text-slate-600">Titulaire : {pm.accountHolder}</div>
                  <div className="text-xs text-slate-500">
                    Statut : {pm.active ? 'Actif' : 'Désactivé'}
                  </div>
                </div>
              ))}
            </div>

            {editingMethod && (
              <div className="p-5 rounded-2xl border-2 border-[#119DA4] bg-[#EDF2F4]/40 space-y-3">
                <div className="grid sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    placeholder="Opérateur (ex : Orange Money)"
                    value={editingMethod.operatorName}
                    onChange={(e) =>
                      setEditingMethod({ ...editingMethod, operatorName: e.target.value })
                    }
                    className="px-3.5 py-2.5 rounded-xl bg-white text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Numéro (+226 ...)"
                    value={editingMethod.phoneNumber}
                    onChange={(e) =>
                      setEditingMethod({ ...editingMethod, phoneNumber: e.target.value })
                    }
                    className="px-3.5 py-2.5 rounded-xl bg-white text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Titulaire du compte"
                    value={editingMethod.accountHolder}
                    onChange={(e) =>
                      setEditingMethod({ ...editingMethod, accountHolder: e.target.value })
                    }
                    className="px-3.5 py-2.5 rounded-xl bg-white text-sm"
                  />
                </div>
                <input
                  type="text"
                  placeholder="Instructions affichées au client"
                  value={editingMethod.instructions}
                  onChange={(e) =>
                    setEditingMethod({ ...editingMethod, instructions: e.target.value })
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white text-sm"
                />
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={editingMethod.active}
                      onChange={(e) =>
                        setEditingMethod({ ...editingMethod, active: e.target.checked })
                      }
                    />
                    Opérateur actif
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        if (staffUser.authMethod === 'credentials') {
                          await savePaymentMethodServer(editingMethod);
                          await refreshCredentialsData();
                        } else {
                          await adminSavePaymentMethod(editingMethod, staffUser.email);
                        }
                        setEditingMethod(null);
                      } catch (err) {
                        setDataError(
                          err instanceof Error
                            ? err.message
                            : 'Impossible de sauvegarder cet opérateur.'
                        );
                      }
                    }}
                    className="px-5 py-2 rounded-full bg-[#26547C] text-white text-xs font-semibold"
                  >
                    Enregistrer
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingMethod(null)}
                    className="text-xs text-slate-500"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TABS: SERVICES / CLIENTS / STATS / SETTINGS */}
      {(activeTab === 'services' ||
        activeTab === 'clients' ||
        activeTab === 'stats' ||
        activeTab === 'settings') && (
        <AdminSettingsTabs
          activeTab={activeTab}
          staffUser={staffUser}
          services={services}
          orders={orders}
          payments={payments}
          clients={clients}
          auditLogs={auditLogs}
          settings={settings}
          onReprintOrder={onReprintOrder}
          onRefreshData={refreshCredentialsData}
        />
      )}

      {/* Order Detail Modal */}
      {selectedOrder && (
        <AdminOrderDetailModal
          order={selectedOrder}
          staffUser={staffUser}
          settings={settings}
          onClose={() => setSelectedOrderId(null)}
          onRefreshData={refreshCredentialsData}
        />
      )}

      {/* Manual Counter Order Modal */}
      {showManualModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateManualOrder}
            className="bg-white rounded-3xl max-w-md w-full p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xl text-[#26547C]">
                Nouvelle commande manuelle
              </h3>
              <button type="button" onClick={() => setShowManualModal(false)}>
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            <input
              type="text"
              required
              placeholder="Nom complet du client *"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm"
            />
            <input
              type="tel"
              required
              placeholder="Téléphone +226 *"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm"
            />
            <select
              value={manualServiceId}
              onChange={(e) => setManualServiceId(e.target.value)}
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm"
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {(() => {
              const selectedSrv =
                services.find((s) => s.id === manualServiceId) || services[0];
              if (selectedSrv && isApparelSlug(selectedSrv.slug)) {
                const art = getApparelTypeFromSlug(selectedSrv.slug);
                const opts = APPAREL_SIZE_OPTIONS[art];
                return (
                  <div className="space-y-1.5">
                    <span className="block text-xs font-semibold text-[#26547C]">
                      Quantités par taille :
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      {opts.map((sz) => (
                        <div
                          key={sz}
                          className="bg-[#EDF2F4] rounded-xl p-1.5 text-center"
                        >
                          <span className="block text-[11px] font-bold text-[#26547C]">
                            {sz}
                          </span>
                          <input
                            type="number"
                            min={0}
                            value={manualSizes[sz] ?? 0}
                            onChange={(e) =>
                              setManualSizes((prev) => ({
                                ...prev,
                                [sz]: Math.max(0, Number(e.target.value)),
                              }))
                            }
                            className="w-full text-center bg-white rounded-lg py-1 text-xs font-semibold"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <input
                  type="number"
                  min={1}
                  value={manualQty}
                  onChange={(e) => setManualQty(Math.max(1, Number(e.target.value)))}
                  placeholder="Quantité"
                  className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm"
                />
              );
            })()}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={manualUrgent}
                onChange={(e) => setManualUrgent(e.target.checked)}
              />
              Commande urgente
            </label>
            <textarea
              rows={2}
              placeholder="Notes internes..."
              value={manualNotes}
              onChange={(e) => setManualNotes(e.target.value)}
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm"
            />
            {manualError && <p className="text-xs text-[#EF233C]">{manualError}</p>}
            <button
              type="submit"
              className="w-full py-3 rounded-full bg-[#EF233C] text-white font-semibold text-sm min-h-[44px]"
            >
              Créer la commande
            </button>
          </form>
        </div>
      )}

      {/* Reject Payment Reason Modal */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-bold text-lg text-[#26547C]">
              Motif de rejet ({rejectTarget.orderNumber})
            </h3>
            <textarea
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Ex : Capture illisible, montant insuffisant, référence introuvable..."
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectTarget(null)}
                className="px-4 py-2 rounded-full border border-slate-300 text-sm"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={async () => {
                  const linked = orders.find((o) => o.orderId === rejectTarget.orderId);
                  if (linked && rejectReason.trim()) {
                    try {
                      if (staffUser.authMethod === 'credentials') {
                        await rejectPaymentServer(
                          rejectTarget.paymentId,
                          rejectReason.trim()
                        );
                        await refreshCredentialsData();
                      } else {
                        await adminRejectPayment({
                          payment: rejectTarget,
                          order: linked,
                          reason: rejectReason.trim(),
                          actorEmail: staffUser.email,
                          actorRole: staffUser.role,
                        });
                      }
                      showToast({
                        id: `payment_rejected_${rejectTarget.paymentId}`,
                        badge: rejectTarget.orderNumber,
                        title: 'Paiement rejeté',
                        message: `${rejectTarget.customerName} a été notifié du rejet.`,
                        variant: 'warning',
                        durationMs: 6000,
                      });
                      setRejectTarget(null);
                    } catch (err) {
                      setDataError(
                        err instanceof Error
                          ? err.message
                          : 'Impossible de rejeter ce paiement.'
                      );
                    }
                  }
                }}
                className="px-5 py-2 rounded-full bg-[#EF233C] text-white text-sm font-semibold"
              >
                Confirmer le rejet
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Screenshot Lightbox */}
      {screenshotModalUrl && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="font-bold text-sm text-[#26547C]">
                Capture de paiement Mobile Money
              </span>
              <button type="button" onClick={() => setScreenshotModalUrl(null)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <img
              src={screenshotModalUrl}
              alt="Capture de paiement"
              className="max-h-[70vh] mx-auto rounded-2xl object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
};
