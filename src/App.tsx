import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PAYMENT_METHODS, DEFAULT_SERVICES, DEFAULT_SETTINGS } from './data/defaults';
import {
  fetchOrderById,
  findOrderByNumberAndPhone,
  subscribePublicCatalog,
  subscribeSingleOrder,
} from './lib/firestoreApi';
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
  isAudioChimeEnabled,
  isBrowserNotifEnabled,
  playNotificationChime,
} from './lib/browserNotifications';
import type { Order, PaymentMethod, PrintService, ShopSettings } from './types/fbc';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header, type AppView } from './components/Header';
import { LandingHero } from './components/LandingHero';
import { OfflineIndicator } from './components/OfflineIndicator';
import { OrderTrackingView } from './components/OrderTrackingView';
import { OrderWizard } from './components/OrderWizard';
import { ToastProvider, useToast } from './components/ToastProvider';

const TRACKED_ORDER_STORAGE_KEY = 'fbc_tracked_order_id';

function saveTrackedOrderId(orderId: string | null) {
  try {
    if (orderId) {
      window.localStorage.setItem(TRACKED_ORDER_STORAGE_KEY, orderId);
    } else {
      window.localStorage.removeItem(TRACKED_ORDER_STORAGE_KEY);
    }
  } catch {
    // Ignore storage unavailability (e.g. private browsing restrictions)
  }
}

function readSavedTrackedOrderId(): string | null {
  try {
    return window.localStorage.getItem(TRACKED_ORDER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function AppContent() {
  const { showToast } = useToast();
  const [view, setView] = useState<AppView>('home');
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [services, setServices] = useState<PrintService[]>(DEFAULT_SERVICES);
  const [paymentMethods, setPaymentMethods] =
    useState<PaymentMethod[]>(DEFAULT_PAYMENT_METHODS);

  const [preselectedServiceId, setPreselectedServiceId] = useState<string | undefined>();
  const [trackedOrderId, setTrackedOrderId] = useState<string | null>(null);
  const [trackedOrder, setTrackedOrder] = useState<Order | null>(null);

  const viewRef = useRef<AppView>(view);
  viewRef.current = view;

  const prevOrderSnapshotRef = useRef<OrderSnapshotState | null>(null);

  // Subscribe to public shop settings, services catalog, and payment methods
  useEffect(() => {
    const unsub = subscribePublicCatalog(setSettings, setServices, setPaymentMethods);
    return () => unsub();
  }, []);

  // Support direct private tracking URL (?track=ord_...) or restore last tracked order quietly
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const trackId = params.get('track');
    const savedId = !trackId ? readSavedTrackedOrderId() : null;
    const initialId = trackId || savedId;
    if (!initialId) return;

    fetchOrderById(initialId)
      .then((ord) => {
        if (ord) {
          prevOrderSnapshotRef.current = extractOrderSnapshot(ord);
          setTrackedOrderId(ord.orderId);
          setTrackedOrder(ord);
          saveTrackedOrderId(ord.orderId);
          if (trackId) {
            setView('track');
          }
        } else if (savedId) {
          saveTrackedOrderId(null);
        }
      })
      .catch(() => {
        if (savedId) saveTrackedOrderId(null);
      });
  }, []);

  // Live updates for the tracked order + real-time toast notifications on status changes
  useEffect(() => {
    if (!trackedOrderId) return;
    const unsub = subscribeSingleOrder(trackedOrderId, (ord) => {
      if (!ord) return;
      setTrackedOrder(ord);

      const prev = prevOrderSnapshotRef.current;
      if (prev && prev.orderId === ord.orderId) {
        const notifications = buildOrderChangeToasts(prev, ord, {
          isOnTrackingView: viewRef.current === 'track',
          onOpenTracking: () => {
            setView('track');
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
              url: `/client/?track=${encodeURIComponent(ord.orderId)}`,
              swScope: '/client/',
              requireInteraction:
                ord.status === 'fichier_a_corriger' || ord.status === 'prete',
            });
          }
        }
      }
      prevOrderSnapshotRef.current = extractOrderSnapshot(ord);
    });
    return () => unsub();
  }, [trackedOrderId, showToast]);

  const handleStartOrder = (serviceId?: string) => {
    setPreselectedServiceId(serviceId);
    setView('order');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleTrackLookup = async (
    orderNumber: string,
    phone: string
  ): Promise<string | null> => {
    try {
      const found = await findOrderByNumberAndPhone(orderNumber, phone);
      if (!found) {
        return 'Aucune commande trouvée avec ce numéro de commande et ce téléphone.';
      }
      prevOrderSnapshotRef.current = extractOrderSnapshot(found);
      setTrackedOrderId(found.orderId);
      setTrackedOrder(found);
      saveTrackedOrderId(found.orderId);
      setView('track');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return null;
    } catch {
      return 'Impossible de vérifier cette commande. Vérifiez le format du numéro.';
    }
  };

  const handleOrderCreatedAndTrack = (order: Order) => {
    prevOrderSnapshotRef.current = extractOrderSnapshot(order);
    setTrackedOrderId(order.orderId);
    setTrackedOrder(order);
    saveTrackedOrderId(order.orderId);
    setView('track');
    window.history.replaceState({}, '', `/client/?track=${encodeURIComponent(order.orderId)}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast({
      id: `order_created_${order.orderId}`,
      badge: order.orderNumber,
      title: 'Commande enregistrée !',
      message:
        'Vous recevrez ici des notifications en temps réel à chaque changement de statut.',
      variant: 'success',
      durationMs: 7000,
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#EDF2F4] text-black">
      <Header
        currentView={view}
        onNavigate={(v) => {
          setView(v);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onStartOrder={() => handleStartOrder()}
      />

      <OfflineIndicator />

      <main className="flex-1">
        {view === 'home' && (
          <LandingHero
            services={services}
            settings={settings}
            onStartOrder={handleStartOrder}
            onTrackLookup={handleTrackLookup}
          />
        )}

        {view === 'order' && (
          <OrderWizard
            services={services}
            paymentMethods={paymentMethods}
            settings={settings}
            preselectedServiceId={preselectedServiceId}
            onOrderCreatedAndTrack={handleOrderCreatedAndTrack}
            onBackHome={() => setView('home')}
          />
        )}

        {view === 'track' && (
          <OrderTrackingView
            order={trackedOrder}
            settings={settings}
            paymentMethods={paymentMethods}
            onLookup={handleTrackLookup}
            onResetOrder={() => {
              prevOrderSnapshotRef.current = null;
              setTrackedOrderId(null);
              setTrackedOrder(null);
              saveTrackedOrderId(null);
              window.history.replaceState({}, '', '/client/');
            }}
          />
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
