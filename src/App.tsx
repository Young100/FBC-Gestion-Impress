import { useEffect, useState } from 'react';
import { DEFAULT_PAYMENT_METHODS, DEFAULT_SERVICES, DEFAULT_SETTINGS } from './data/defaults';
import {
  fetchOrderById,
  findOrderByNumberAndPhone,
  subscribePublicCatalog,
  subscribeSingleOrder,
} from './lib/firestoreApi';
import type { Order, PaymentMethod, PrintService, ShopSettings } from './types/fbc';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header, type AppView } from './components/Header';
import { LandingHero } from './components/LandingHero';
import { OrderTrackingView } from './components/OrderTrackingView';
import { OrderWizard } from './components/OrderWizard';

export default function App() {
  const [view, setView] = useState<AppView>('home');
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [services, setServices] = useState<PrintService[]>(DEFAULT_SERVICES);
  const [paymentMethods, setPaymentMethods] =
    useState<PaymentMethod[]>(DEFAULT_PAYMENT_METHODS);

  const [preselectedServiceId, setPreselectedServiceId] = useState<string | undefined>();
  const [trackedOrderId, setTrackedOrderId] = useState<string | null>(null);
  const [trackedOrder, setTrackedOrder] = useState<Order | null>(null);

  // Subscribe to public shop settings, services catalog, and payment methods
  useEffect(() => {
    const unsub = subscribePublicCatalog(setSettings, setServices, setPaymentMethods);
    return () => unsub();
  }, []);

  // Support direct private tracking URL (?track=ord_...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const trackId = params.get('track');
    if (trackId) {
      fetchOrderById(trackId)
        .then((ord) => {
          if (ord) {
            setTrackedOrderId(ord.orderId);
            setTrackedOrder(ord);
            setView('track');
          }
        })
        .catch(() => {});
    }
  }, []);

  // Live updates for the tracked order
  useEffect(() => {
    if (!trackedOrderId) return;
    const unsub = subscribeSingleOrder(trackedOrderId, (ord) => {
      if (ord) setTrackedOrder(ord);
    });
    return () => unsub();
  }, [trackedOrderId]);

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
      setTrackedOrderId(found.orderId);
      setTrackedOrder(found);
      setView('track');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return null;
    } catch {
      return 'Impossible de vérifier cette commande. Vérifiez le format du numéro.';
    }
  };

  const handleOrderCreatedAndTrack = (order: Order) => {
    setTrackedOrderId(order.orderId);
    setTrackedOrder(order);
    setView('track');
    window.history.replaceState({}, '', `?track=${encodeURIComponent(order.orderId)}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-[#EDF2F4] text-black">
        <Header
          currentView={view}
          onNavigate={(v) => {
            setView(v);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onStartOrder={() => handleStartOrder()}
        />

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
                setTrackedOrderId(null);
                setTrackedOrder(null);
                window.history.replaceState({}, '', '/');
              }}
            />
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
