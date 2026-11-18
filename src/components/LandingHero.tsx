import React, { useState } from 'react';
import {
  ArrowRight,
  Clock,
  FileCheck2,
  Mail,
  MapPin,
  Phone,
  Printer,
  Search,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { getServiceImageSrc, SERVICE_IMAGES } from '../data/defaults';
import { formatFcfa } from '../lib/pricing';
import type { PrintService, ShopSettings } from '../types/fbc';

interface LandingHeroProps {
  services: PrintService[];
  settings: ShopSettings;
  onStartOrder: (preselectedServiceId?: string) => void;
  onTrackLookup: (orderNumber: string, phone: string) => Promise<string | null>;
}

export const LandingHero: React.FC<LandingHeroProps> = ({
  services,
  settings,
  onStartOrder,
  onTrackLookup,
}) => {
  const [orderNum, setOrderNum] = useState('');
  const [phone, setPhone] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const activeServices = services.filter((s) => s.active);

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLookupError(null);
    if (!orderNum.trim() || !phone.trim()) {
      setLookupError('Veuillez saisir votre numéro de commande et votre téléphone.');
      return;
    }
    setSearching(true);
    try {
      const err = await onTrackLookup(orderNum, phone);
      if (err) setLookupError(err);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="fbc-pattern-bg">
      {!settings.isOpen && (
        <div className="bg-[#EF233C] text-white px-4 py-3 text-center text-sm font-medium">
          {settings.closedMessage}
        </div>
      )}

      {/* Hero Split */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-12 lg:pt-14 lg:pb-16">
        <div className="grid lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl text-[#26547C] leading-[1.12] [text-wrap:balance]">
              Commandez vos impressions sans perdre un seul pixel.
            </h1>

            <p className="text-base sm:text-lg text-slate-700 leading-relaxed max-w-xl">
              Envoyez vos fichiers haute résolution sans aucune compression WhatsApp,
              obtenez votre devis PDF immédiat en FCFA, payez par Mobile Money et suivez
              la fabrication à distance.
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <button
                type="button"
                onClick={() => onStartOrder()}
                className="inline-flex items-center justify-center gap-2.5 px-7 py-4 rounded-full bg-[#EF233C] text-white font-semibold text-base hover:bg-[#d81b32] active:scale-[0.98] transition-all shadow-sm min-h-[48px]"
              >
                Passer ma commande
                <ArrowRight className="w-5 h-5" />
              </button>

              <a
                href="#tarifs-prestations"
                className="inline-flex items-center justify-center px-6 py-4 rounded-full border-2 border-[#119DA4] text-[#26547C] font-semibold text-base hover:bg-[#119DA4]/10 transition-colors min-h-[48px]"
              >
                Voir les prestations
              </a>
            </div>

            {/* Proof Metrics Row */}
            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-slate-300/70">
              <div>
                <div className="text-lg sm:text-xl font-bold text-[#26547C] tabular-nums">
                  0 %
                </div>
                <div className="text-xs sm:text-sm text-slate-600">
                  Compression des fichiers
                </div>
              </div>
              <div>
                <div className="text-lg sm:text-xl font-bold text-[#26547C] tabular-nums">
                  {settings.maxFileSizeMb >= 1024 ? '1 Go' : `${settings.maxFileSizeMb} Mo`}
                </div>
                <div className="text-xs sm:text-sm text-slate-600">
                  Reprise auto réseau
                </div>
              </div>
              <div>
                <div className="text-lg sm:text-xl font-bold text-[#26547C] tabular-nums">
                  24h/24
                </div>
                <div className="text-xs sm:text-sm text-slate-600">
                  Devis &amp; suivi en ligne
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="relative h-64 sm:h-80 lg:h-full min-h-[320px] rounded-3xl overflow-hidden bg-[#26547C]/10 border border-slate-200 shadow-sm">
              <img
                src={SERVICE_IMAGES.hero}
                alt="Atelier d’impression FBC Print — brochures, cartes de visite et kakemono"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent p-6 text-white">
                <p className="text-sm font-medium text-white/90">
                  Transfert binaire direct · Vérification SHA-256 · Aperçu atelier
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Remote Order Tracking Bar */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200/90 shadow-sm">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
            <div className="space-y-1.5 lg:max-w-sm">
              <h2 className="font-display text-xl sm:text-2xl text-[#26547C]">
                Suivre une commande existante
              </h2>
              <p className="text-sm text-slate-600">
                Consultez l’avancement, téléchargez votre devis ou reçu, ou déclarez un
                paiement Mobile Money.
              </p>
            </div>

            <form
              onSubmit={handleSearchSubmit}
              className="flex-1 grid sm:grid-cols-3 gap-3 items-start"
            >
              <div>
                <label
                  htmlFor="quick-order-num"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  Numéro de commande
                </label>
                <input
                  id="quick-order-num"
                  type="text"
                  placeholder="Ex : CMD-2026-0042"
                  value={orderNum}
                  onChange={(e) => setOrderNum(e.target.value)}
                  className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
                />
              </div>

              <div>
                <label
                  htmlFor="quick-phone"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  Téléphone utilisé
                </label>
                <input
                  id="quick-phone"
                  type="tel"
                  placeholder="Ex : 74 67 77 08"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
                />
              </div>

              <div className="sm:pt-5">
                <button
                  type="submit"
                  disabled={searching}
                  className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] transition-colors min-h-[48px] disabled:opacity-60"
                >
                  <Search className="w-4 h-4" />
                  {searching ? 'Recherche...' : 'Accéder au suivi'}
                </button>
              </div>
            </form>
          </div>
          {lookupError && (
            <p className="mt-3 text-sm font-medium text-[#EF233C]">{lookupError}</p>
          )}
        </div>
      </section>

      {/* Prestations Grid */}
      <section
        id="tarifs-prestations"
        className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-14"
      >
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <h2 className="font-display text-2xl sm:text-3xl text-[#26547C]">
              Nos prestations d’impression
            </h2>
            <p className="text-base text-slate-600 mt-1">
              Sélectionnez un support pour configurer vos dimensions, quantités et fichiers.
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {activeServices.map((service) => {
            const imgSrc = getServiceImageSrc(service);
            return (
              <div
                key={service.id}
                className="bg-white rounded-3xl overflow-hidden border border-slate-200/80 shadow-sm flex flex-col hover:border-[#119DA4] transition-colors"
              >
                <div className="h-44 bg-[#EDF2F4] overflow-hidden relative">
                  <img
                    src={imgSrc}
                    alt={service.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-6 flex-1 flex flex-col justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-bold text-[#26547C]">{service.name}</h3>
                    <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                      {service.description}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                    <div>
                      <span className="block text-xs text-slate-500">À partir de</span>
                      <span className="text-base font-bold text-[#26547C] tabular-nums">
                        {formatFcfa(service.basePrice)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onStartOrder(service.id)}
                      className="px-5 py-2.5 rounded-full bg-[#EDF2F4] text-[#26547C] font-semibold text-sm hover:bg-[#26547C] hover:text-white transition-colors min-h-[44px]"
                    >
                      Configurer
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Workflow guarantees */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        <div className="bg-[#26547C] text-white rounded-3xl p-8 sm:p-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="space-y-2">
            <FileCheck2 className="w-7 h-7 text-[#119DA4]" />
            <h3 className="font-bold text-base">Fichiers 100 % intacts</h3>
            <p className="text-sm text-white/80">
              Vos PDF, AI, PSD, CDR, SVG ou images arrivent à l’atelier octet pour octet.
            </p>
          </div>
          <div className="space-y-2">
            <Smartphone className="w-7 h-7 text-[#119DA4]" />
            <h3 className="font-bold text-base">Pensé pour le mobile</h3>
            <p className="text-sm text-white/80">
              Envoi fractionné avec reprise automatique en cas de coupure 3G/4G.
            </p>
          </div>
          <div className="space-y-2">
            <ShieldCheck className="w-7 h-7 text-[#119DA4]" />
            <h3 className="font-bold text-base">Paiement vérifié</h3>
            <p className="text-sm text-white/80">
              Orange Money, Moov, Wave, Coris, Sank ou Telecel avec reçu PDF officiel.
            </p>
          </div>
          <div className="space-y-2">
            <Printer className="w-7 h-7 text-[#119DA4]" />
            <h3 className="font-bold text-base">Suivi transparent</h3>
            <p className="text-sm text-white/80">
              Suivez chaque étape sans vous déplacer jusqu’à la livraison ou au retrait.
            </p>
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="bg-white border-t border-slate-200/80 pt-10 pb-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
            {/* Brand & Summary */}
            <div className="md:col-span-5 space-y-3 min-w-0">
              <div className="flex items-center gap-3">
                <img
                  src="/assets/aistudio/icone_c13161d0.svg"
                  alt={settings.shopName}
                  className="w-8 h-8 object-contain shrink-0"
                />
                <span className="font-display text-lg font-bold text-[#26547C]">
                  {settings.shopName}
                </span>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed max-w-sm">
                Atelier d’impression haute résolution sans compression. Devis instantané en FCFA,
                envoi sécurisé et suivi en ligne.
              </p>
            </div>

            {/* Contact & Location */}
            <div className="md:col-span-4 space-y-3 min-w-0">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#26547C]">
                Atelier &amp; Contact
              </h3>
              <ul className="space-y-2.5 text-sm text-slate-600">
                <li className="flex items-start gap-2.5 min-w-0">
                  <MapPin className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
                  <span className="min-w-0 break-words">{settings.address}</span>
                </li>
                <li className="flex items-start gap-2.5 min-w-0">
                  <Phone className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
                  <a
                    href={`tel:${settings.phone.replace(/\s+/g, '')}`}
                    className="tabular-nums hover:text-[#26547C] transition-colors min-w-0 break-words"
                  >
                    {settings.phone}
                  </a>
                </li>
                <li className="flex items-start gap-2.5 min-w-0">
                  <Mail className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
                  <a
                    href={`mailto:${settings.email}`}
                    className="hover:text-[#26547C] transition-colors min-w-0 break-all sm:break-words"
                  >
                    {settings.email}
                  </a>
                </li>
                {settings.openingHours && (
                  <li className="flex items-start gap-2.5 min-w-0">
                    <Clock className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
                    <span className="min-w-0 break-words">{settings.openingHours}</span>
                  </li>
                )}
              </ul>
            </div>

            {/* Quick Links */}
            <div className="md:col-span-3 space-y-3 min-w-0">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#26547C]">
                Navigation
              </h3>
              <ul className="space-y-2 text-sm text-slate-600">
                <li>
                  <button
                    type="button"
                    onClick={() => onStartOrder()}
                    className="hover:text-[#26547C] font-medium transition-colors text-left py-0.5"
                  >
                    Passer une commande
                  </button>
                </li>
                <li>
                  <a
                    href="#tarifs-prestations"
                    className="inline-block hover:text-[#26547C] font-medium transition-colors py-0.5"
                  >
                    Nos prestations &amp; tarifs
                  </a>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.getElementById('quick-order-num');
                      if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.focus({ preventScroll: true });
                      }
                    }}
                    className="hover:text-[#26547C] font-medium transition-colors text-left py-0.5"
                  >
                    Suivre une commande
                  </button>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 text-center sm:text-left">
            <span>
              © {new Date().getFullYear()} {settings.shopName}. Tous droits réservés.
            </span>
            <span>Transfert original sans perte · Paiement Mobile Money</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
