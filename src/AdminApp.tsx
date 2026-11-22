import { useEffect, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { DEFAULT_PAYMENT_METHODS, DEFAULT_SERVICES, DEFAULT_SETTINGS } from './data/defaults';
import { createOrderInFirestore, subscribePublicCatalog } from './lib/firestoreApi';
import type { Order, PaymentMethod, PrintService, ShopSettings } from './types/fbc';
import { AdminSpace } from './components/AdminSpace';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import { ToastProvider } from './components/ToastProvider';

export default function AdminApp() {
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [services, setServices] = useState<PrintService[]>(DEFAULT_SERVICES);
  const [paymentMethods, setPaymentMethods] =
    useState<PaymentMethod[]>(DEFAULT_PAYMENT_METHODS);
  const [reprintNotice, setReprintNotice] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribePublicCatalog(setSettings, setServices, setPaymentMethods);
    return () => unsub();
  }, []);

  const handleReprintOrder = async (order: Order) => {
    try {
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + (settings.quoteValidityDays || 15));

      const duplicated = await createOrderInFirestore({
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        isWhatsapp: order.isWhatsapp,
        wantsDelivery: order.wantsDelivery,
        deliveryZoneId: order.deliveryZoneId || '',
        deliveryZoneName: order.deliveryZoneName || '',
        deliveryAddress: order.deliveryAddress || '',
        deliveryFee: order.deliveryFee || 0,
        urgent: order.urgent,
        urgentFee: order.urgentFee || 0,
        discountAmount: 0,
        subtotal: order.subtotal,
        totalAmount: order.subtotal + (order.deliveryFee || 0) + (order.urgentFee || 0),
        depositRequiredAmount: Math.round(
          ((order.subtotal + (order.deliveryFee || 0) + (order.urgentFee || 0)) *
            (settings.depositPercent || 70)) /
            100
        ),
        paidAmount: 0,
        status: 'recue',
        paymentStatus: 'non_paye',
        acceptedTerms: true,
        quoteValidUntil: validUntil.toISOString(),
        internalNotes: `Réimpression de la commande ${order.orderNumber}`,
        items: order.items,
        files: order.files.filter((f) => !f.replaced),
        statusHistory: [],
        source: 'manual_admin',
      });

      setReprintNotice(
        `Réimpression créée avec succès : ${duplicated.orderNumber} (${duplicated.customerName})`
      );
      setTimeout(() => setReprintNotice(null), 6000);
    } catch (err) {
      setReprintNotice(
        err instanceof Error
          ? err.message
          : 'Impossible de dupliquer la commande pour réimpression.'
      );
    }
  };

  return (
    <ErrorBoundary>
      <ToastProvider>
        <div className="min-h-screen flex flex-col bg-[#EDF2F4] text-black">
          <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200/80">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src="/assets/aistudio/icone_c13161d0.svg"
                  alt="FBC Print"
                  className="h-9 w-9 sm:hidden object-contain shrink-0"
                />
                <img
                  src="/assets/aistudio/logo_horizontal_123c69c3.svg"
                  alt="FBC Print"
                  className="hidden sm:block h-10 w-auto object-contain shrink-0"
                />
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#26547C]/10 text-[#26547C] text-xs font-bold whitespace-nowrap">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#119DA4]" />
                  Espace Atelier
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <PWAInstallButton
                  variant="compact"
                  appName="FBC Atelier"
                  iconSrc="/atelier-192x192.png"
                  buttonLabel="Installer l’app Atelier"
                />
                <a
                  href="/client/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#EDF2F4] text-[#26547C] text-xs sm:text-sm font-semibold hover:bg-[#26547C] hover:text-white transition-colors min-h-[40px]"
                >
                  Site client
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </header>

          <OfflineIndicator />

          {reprintNotice && (
            <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 pt-4">
              <div className="bg-[#2E9E6B]/15 border border-[#2E9E6B]/30 text-[#237A52] px-4 py-3 rounded-2xl text-sm font-semibold">
                {reprintNotice}
              </div>
            </div>
          )}

          <main className="flex-1">
            <AdminSpace
              services={services}
              paymentMethods={paymentMethods}
              settings={settings}
              onReprintOrder={handleReprintOrder}
            />
          </main>

          <footer className="border-t border-slate-200/80 bg-white/80 py-4 px-4 sm:px-6 lg:px-8">
            <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
              <span>FBC Atelier — Application dédiée à l’équipe d’impression</span>
              <PWAInstallButton
                variant="footer"
                appName="FBC Atelier"
                iconSrc="/atelier-192x192.png"
                buttonLabel="Installer FBC Atelier sur mobile & PC"
              />
            </div>
          </footer>
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
}
