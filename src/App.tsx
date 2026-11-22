import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PAYMENT_METHODS, DEFAULT_SERVICES, DEFAULT_SETTINGS } from './data/defaults';
import {
  ClientApiError,
  fetchClientNotifications,
  fetchClientSession,
  fetchMyOrders,
  markClientNotificationsRead,
  openOrderByTrackingCode,
  subscribeClientWebPush,
} from './lib/clientApi';
import { subscribePublicCatalog } from './lib/firestoreApi';
import {
  buildOrderChangeToasts,
  extractOrderSnapshot,
  type OrderSnapshotState,
} from './lib/orderNotifications';
import {
  CLIENT_PREF_KEY,
  CLIENT_SOUND_KEY,
  dispatchNativeNotification,
  getBrowserNotifPermission,
  initAudioUnlock,
  isAudioChimeEnabled,
  isBrowserNotifEnabled,
  playNotificationChime,
  syncAppIconBadge,
} from './lib/browserNotifications';
import type {
  ClientAccountPublic,
  Order,
  PaymentMethod,
  PrintService,
  ServerNotificationItem,
  ShopSettings,
} from './types/fbc';
import { ClientAuthPanel } from './components/ClientAuthPanel';
import { ClientOrdersDashboard } from './components/ClientOrdersDashboard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header, type AppView } from './components/Header';
import { LandingHero } from './components/LandingHero';
import { OfflineIndicator } from './components/OfflineIndicator';
import { OrderTrackingView } from './components/OrderTrackingView';
import { OrderWizard } from './components/OrderWizard';
import { ToastProvider, useToast } from './components/ToastProvider';

function AppContent() {
  const { showToast } = useToast();
  const [view, setView] = useState<AppView>('home');
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [services, setServices] = useState<PrintService[]>(DEFAULT_SERVICES);
  const [paymentMethods, setPaymentMethods] =
    useState<PaymentMethod[]>(DEFAULT_PAYMENT_METHODS);

  const [clientAccount, setClientAccount] = useState<ClientAccountPublic | null>(null);
  const [myOrders, setMyOrders] = useState<Order[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [sessionBootstrapped, setSessionBootstrapped] = useState(false);
  const [clientNotifications, setClientNotifications] = useState<ServerNotificationItem[]>([]);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);

  const [preselectedServiceId, setPreselectedServiceId] = useState<string | undefined>();
  const [trackedOrder, setTrackedOrder] = useState<Order | null>(null);
  const [pendingTrackingCode, setPendingTrackingCode] = useState<string>('');
  const [trackingSecurityNotice, setTrackingSecurityNotice] = useState<string | null>(null);

  const viewRef = useRef<AppView>(view);
  viewRef.current = view;

  const trackedOrderIdRef = useRef<string | null>(null);
  trackedOrderIdRef.current = trackedOrder?.orderId || null;

  const prevOrderSnapshotsRef = useRef<Map<string, OrderSnapshotState>>(new Map());

  // Unlock WebAudio context on first user interaction so live chimes play reliably
  useEffect(() => {
    return initAudioUnlock();
  }, []);

  // Subscribe to public shop settings, services catalog, and payment methods
  useEffect(() => {
    const unsub = subscribePublicCatalog(setSettings, setServices, setPaymentMethods);
    return () => unsub();
  }, []);

  const syncOrdersAndNotify = useCallback(
    (ordersList: Order[], notifyChanges: boolean) => {
      setMyOrders(ordersList);

      const activeId = trackedOrderIdRef.current;
      if (activeId) {
        const refreshed = ordersList.find((o) => o.orderId === activeId);
        if (refreshed) {
          setTrackedOrder(refreshed);
        }
      }

      const prevMap = prevOrderSnapshotsRef.current;
      const nextMap = new Map<string, OrderSnapshotState>();

      for (const ord of ordersList) {
        const prev = prevMap.get(ord.orderId);
        if (notifyChanges && prev) {
          const notifications = buildOrderChangeToasts(prev, ord, {
            isOnTrackingView:
              viewRef.current === 'orders' && trackedOrderIdRef.current === ord.orderId,
            onOpenTracking: () => {
              setTrackedOrder(ord);
              setPendingTrackingCode(ord.trackingCode);
              setView('orders');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            },
          });
          for (const toast of notifications) {
            showToast(toast);
            if (isAudioChimeEnabled(CLIENT_SOUND_KEY)) {
              playNotificationChime(toast.variant || 'info');
            }
            if (
              isBrowserNotifEnabled(CLIENT_PREF_KEY) &&
              getBrowserNotifPermission() === 'granted'
            ) {
              void dispatchNativeNotification({
                title: `${ord.orderNumber} — ${toast.title}`,
                body: toast.message,
                tag: toast.id,
                icon: '/pwa-192x192.png',
                badge: '/pwa-192x192.png',
                url: `/client/?code=${encodeURIComponent(ord.trackingCode)}`,
                swScope: '/client/',
                requireInteraction:
                  ord.status === 'fichier_a_corriger' || ord.status === 'prete',
              });
            }
          }
        }
        nextMap.set(ord.orderId, extractOrderSnapshot(ord));
      }

      prevOrderSnapshotsRef.current = nextMap;
    },
    [showToast]
  );

  const loadClientNotifications = useCallback(async () => {
    try {
      const res = await fetchClientNotifications();
      setClientNotifications(res.notifications);
      setUnreadNotifCount(res.unreadCount);
      void syncAppIconBadge(res.unreadCount, '/client/');
    } catch {
      // Ignore transient notification fetch errors
    }
  }, []);

  const loadMyOrders = useCallback(
    async (notifyChanges: boolean) => {
      setLoadingOrders(true);
      try {
        const list = await fetchMyOrders();
        syncOrdersAndNotify(list, notifyChanges);
        await loadClientNotifications();
      } catch (err) {
        if (err instanceof ClientApiError && err.status === 401) {
          setClientAccount(null);
          setMyOrders([]);
          setClientNotifications([]);
          setUnreadNotifCount(0);
          void syncAppIconBadge(0, '/client/');
          setTrackedOrder(null);
          prevOrderSnapshotsRef.current.clear();
        }
      } finally {
        setLoadingOrders(false);
      }
    },
    [syncOrdersAndNotify, loadClientNotifications]
  );

  // Bootstrap client session + enforce authentication on shared links (?code= / ?track=)
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const codeParam = params.get('code')?.trim().toUpperCase() || '';
    const legacyTrackParam = params.get('track')?.trim() || '';

    if (legacyTrackParam) {
      window.history.replaceState({}, '', '/client/');
    }

    (async () => {
      try {
        const session = await fetchClientSession();
        if (!active) return;

        if (session.authenticated && session.account) {
          setClientAccount(session.account);
          const list = await fetchMyOrders().catch(() => [] as Order[]);
          if (!active) return;
          syncOrdersAndNotify(list, false);

          if (codeParam) {
            setPendingTrackingCode(codeParam);
            try {
              const res = await openOrderByTrackingCode(codeParam);
              if (!active) return;
              setTrackedOrder(res.order);
              setTrackingSecurityNotice(null);
              setView('orders');
              if (!list.some((o) => o.orderId === res.order.orderId)) {
                syncOrdersAndNotify([res.order, ...list], false);
              }
            } catch (err) {
              if (!active) return;
              setTrackedOrder(null);
              setTrackingSecurityNotice(
                err instanceof Error
                  ? err.message
                  : 'Accès refusé : cette commande appartient à un autre compte client.'
              );
              setView('orders');
            }
          } else if (legacyTrackParam) {
            setTrackedOrder(null);
            setTrackingSecurityNotice(
              'Ouvrez votre commande depuis votre espace « Mes commandes » ou via son code de suivi.'
            );
            setView('orders');
          }
        } else {
          setClientAccount(null);
          setTrackedOrder(null);
          if (codeParam) {
            setPendingTrackingCode(codeParam);
            setTrackingSecurityNotice(
              `Connectez-vous ou créez votre compte client pour consulter la commande ${codeParam} en toute confidentialité.`
            );
            setView('orders');
          } else if (legacyTrackParam) {
            setTrackingSecurityNotice(
              'Par mesure de sécurité, connectez-vous à votre compte client pour accéder à votre commande.'
            );
            setView('orders');
          }
        }
      } catch {
        // Ignore startup probe errors
      } finally {
        if (active) setSessionBootstrapped(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [syncOrdersAndNotify]);

  // Auto-subscribe Web Push and load Notification Center whenever client is logged in
  useEffect(() => {
    if (!clientAccount || !sessionBootstrapped) return;
    void loadClientNotifications();
    if (
      getBrowserNotifPermission() === 'granted' &&
      isBrowserNotifEnabled(CLIENT_PREF_KEY)
    ) {
      void subscribeClientWebPush();
    }
  }, [clientAccount, sessionBootstrapped, loadClientNotifications]);

  // Poll authenticated client orders + notifications every 8s and refresh on tab foreground
  useEffect(() => {
    if (!clientAccount || !sessionBootstrapped) return;
    const interval = window.setInterval(() => {
      void loadMyOrders(true);
    }, 8000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadMyOrders(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [clientAccount, sessionBootstrapped, loadMyOrders]);

  const handleStartOrder = (serviceId?: string) => {
    setPreselectedServiceId(serviceId);
    setView('order');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleOrderUpdated = useCallback((updated: Order) => {
    setTrackedOrder((prev) =>
      prev && prev.orderId === updated.orderId ? updated : prev
    );
    setMyOrders((prev) => {
      const exists = prev.some((o) => o.orderId === updated.orderId);
      return exists
        ? prev.map((o) => (o.orderId === updated.orderId ? updated : o))
        : [updated, ...prev];
    });
    prevOrderSnapshotsRef.current.set(updated.orderId, extractOrderSnapshot(updated));
  }, []);

  const handleOpenCode = async (trackingCode: string): Promise<string | null> => {
    const cleanCode = trackingCode.trim().toUpperCase();
    if (cleanCode.startsWith('CMD-')) {
      return 'Le suivi s’effectue avec votre code de suivi (ex : FBC-A7K9M2) et non avec le numéro de commande.';
    }
    if (!clientAccount) {
      setPendingTrackingCode(cleanCode);
      setTrackedOrder(null);
      setTrackingSecurityNotice(
        `Connectez-vous à votre compte client ou créez votre compte pour consulter la commande ${cleanCode} en toute confidentialité.`
      );
      setView('orders');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return null;
    }

    try {
      const res = await openOrderByTrackingCode(cleanCode);
      handleOrderUpdated(res.order);
      setTrackedOrder(res.order);
      setPendingTrackingCode(res.order.trackingCode);
      setTrackingSecurityNotice(null);
      setView('orders');
      window.history.replaceState(
        {},
        '',
        `/client/?code=${encodeURIComponent(res.order.trackingCode)}`
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return null;
    } catch (err) {
      if (err instanceof ClientApiError && err.status === 401) {
        setClientAccount(null);
        setTrackedOrder(null);
        setPendingTrackingCode(cleanCode);
        setTrackingSecurityNotice(err.message);
        setView('orders');
      }
      return err instanceof Error
        ? err.message
        : 'Impossible d’ouvrir cette commande avec votre compte.';
    }
  };

  const handleClientAuthenticated = async (
    account: ClientAccountPublic,
    claimedOrder?: Order
  ) => {
    setClientAccount(account);
    const list = await fetchMyOrders().catch(() => [] as Order[]);
    const combined =
      claimedOrder && !list.some((o) => o.orderId === claimedOrder.orderId)
        ? [claimedOrder, ...list]
        : list;
    syncOrdersAndNotify(combined, false);

    if (claimedOrder) {
      setTrackedOrder(claimedOrder);
      setPendingTrackingCode(claimedOrder.trackingCode);
      setTrackingSecurityNotice(null);
      setView('orders');
      window.history.replaceState(
        {},
        '',
        `/client/?code=${encodeURIComponent(claimedOrder.trackingCode)}`
      );
      return;
    }

    if (pendingTrackingCode) {
      try {
        const res = await openOrderByTrackingCode(pendingTrackingCode);
        handleOrderUpdated(res.order);
        setTrackedOrder(res.order);
        setTrackingSecurityNotice(null);
        setView('orders');
        window.history.replaceState(
          {},
          '',
          `/client/?code=${encodeURIComponent(res.order.trackingCode)}`
        );
      } catch (err) {
        setTrackedOrder(null);
        setTrackingSecurityNotice(
          err instanceof Error
            ? err.message
            : 'Cette commande appartient à un autre compte client.'
        );
        setView('orders');
      }
    }
  };

  const handleOrderCreatedAndTrack = (order: Order) => {
    handleOrderUpdated(order);
    setTrackedOrder(order);
    setTrackingSecurityNotice(null);
    setPendingTrackingCode(order.trackingCode);
    setView('orders');
    window.history.replaceState(
      {},
      '',
      `/client/?code=${encodeURIComponent(order.trackingCode)}`
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast({
      id: `order_created_${order.orderId}`,
      badge: order.orderNumber,
      title: 'Commande enregistrée !',
      message: `Conservez votre code de suivi ${order.trackingCode}. Vous recevrez les notifications en temps réel dans votre espace « Mes commandes ».`,
      variant: 'success',
      durationMs: 7500,
    });
  };

  const handleLoggedOut = () => {
    setClientAccount(null);
    setMyOrders([]);
    setClientNotifications([]);
    setUnreadNotifCount(0);
    void syncAppIconBadge(0, '/client/');
    setTrackedOrder(null);
    setPendingTrackingCode('');
    setTrackingSecurityNotice(null);
    prevOrderSnapshotsRef.current.clear();
    window.history.replaceState({}, '', '/client/');
  };

  const handleOpenNotification = async (notif: ServerNotificationItem) => {
    if (!notif.read) {
      setClientNotifications((prev) =>
        prev.map((n) => (n.notifId === notif.notifId ? { ...n, read: true } : n))
      );
      setUnreadNotifCount((c) => {
        const next = Math.max(0, c - 1);
        void syncAppIconBadge(next, '/client/');
        return next;
      });
      void markClientNotificationsRead(notif.notifId).catch(() => {});
    }

    if (notif.trackingCode) {
      await handleOpenCode(notif.trackingCode);
    } else {
      setTrackedOrder(null);
      setView('orders');
    }
  };

  const handleMarkAllNotifsRead = async () => {
    setClientNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadNotifCount(0);
    await markClientNotificationsRead().catch(() => {});
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#EDF2F4] text-black">
      <Header
        currentView={view}
        clientAccount={clientAccount}
        notifications={clientNotifications}
        unreadCount={unreadNotifCount}
        onNavigate={(v) => {
          if (v === 'orders' && view !== 'orders') {
            setTrackedOrder(null);
            setTrackingSecurityNotice(null);
          }
          setView(v);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onStartOrder={() => handleStartOrder()}
        onOpenNotification={(n) => void handleOpenNotification(n)}
        onMarkAllRead={() => void handleMarkAllNotifsRead()}
      />

      <OfflineIndicator />

      <main className="flex-1">
        {view === 'home' && (
          <LandingHero
            services={services}
            settings={settings}
            clientAccount={clientAccount}
            onStartOrder={handleStartOrder}
            onQuickTrackCode={handleOpenCode}
            onGoToAccount={() => {
              setTrackedOrder(null);
              setView('orders');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        )}

        {view === 'order' && (
          <OrderWizard
            services={services}
            paymentMethods={paymentMethods}
            settings={settings}
            clientAccount={clientAccount}
            preselectedServiceId={preselectedServiceId}
            onClientAuthenticated={(acc, claimed) => {
              void handleClientAuthenticated(acc, claimed);
            }}
            onOrderCreatedAndTrack={handleOrderCreatedAndTrack}
            onOrderUpdated={handleOrderUpdated}
            onBackHome={() => setView('home')}
          />
        )}

        {view === 'orders' && (
          !clientAccount ? (
            <div className="max-w-xl mx-auto px-4 py-10 sm:py-12">
              <ClientAuthPanel
                initialMode="login"
                prefilledTrackingCode={pendingTrackingCode}
                notice={trackingSecurityNotice}
                shopWhatsapp={settings.whatsapp}
                onAuthenticated={(acc, claimed) => {
                  void handleClientAuthenticated(acc, claimed);
                }}
              />
            </div>
          ) : trackedOrder ? (
            <OrderTrackingView
              order={trackedOrder}
              clientAccount={clientAccount}
              settings={settings}
              paymentMethods={paymentMethods}
              initialTrackingCode={pendingTrackingCode}
              securityNotice={trackingSecurityNotice}
              onAuthenticated={(acc, claimed) => {
                void handleClientAuthenticated(acc, claimed);
              }}
              onOpenCode={handleOpenCode}
              onOrderUpdated={handleOrderUpdated}
              onBackToOrders={() => {
                setTrackedOrder(null);
                setPendingTrackingCode('');
                setTrackingSecurityNotice(null);
                window.history.replaceState({}, '', '/client/');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onNotificationsChanged={() => void loadClientNotifications()}
            />
          ) : (
            <ClientOrdersDashboard
              account={clientAccount}
              orders={myOrders}
              loading={loadingOrders}
              securityNotice={trackingSecurityNotice}
              onRefresh={() => loadMyOrders(false)}
              onOpenOrder={(ord) => {
                setTrackedOrder(ord);
                setPendingTrackingCode(ord.trackingCode);
                setTrackingSecurityNotice(null);
                window.history.replaceState(
                  {},
                  '',
                  `/client/?code=${encodeURIComponent(ord.trackingCode)}`
                );
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              onOpenCode={handleOpenCode}
              onStartOrder={() => handleStartOrder()}
              onAccountUpdated={(updatedAcc) => setClientAccount(updatedAcc)}
              onLoggedOut={handleLoggedOut}
              onNotificationsChanged={() => void loadClientNotifications()}
            />
          )
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  );
}
