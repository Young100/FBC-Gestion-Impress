import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileCheck2,
  Loader2,
  Pause,
  Play,
  Plus,
  ShoppingBag,
  Trash2,
  UploadCloud,
  Wallet,
} from 'lucide-react';
import { APPAREL_SIZE_OPTIONS, getServiceImageSrc } from '../data/defaults';
import { createClientOrder } from '../lib/clientApi';
import { generateQuotePdf } from '../lib/pdfGenerator';
import {
  APPAREL_DISPOSITION_LABELS,
  APPAREL_TYPE_LABELS,
  calculateItemPricing,
  estimatePrintDpi,
  formatBytes,
  formatFcfa,
  getApparelTypeFromSlug,
  getJerseySizeBreakdown,
  getNonZeroApparelSizes,
  getRequiredSlotsForItem,
  isApparelSlug,
  normalizeBurkinaPhone,
} from '../lib/pricing';
import {
  startResumableUpload,
  type ResumableUploadController,
  type UploadProgressState,
} from '../lib/uploadClient';
import type {
  ApparelDisposition,
  ApparelPrintTech,
  ApparelType,
  ClientAccountPublic,
  JerseyRow,
  Order,
  OrderItem,
  PaymentMethod,
  PrintService,
  ShopSettings,
  UploadedFileMeta,
} from '../types/fbc';
import { ApparelDiagram } from './ApparelDiagram';
import { ClientAuthPanel } from './ClientAuthPanel';
import { PaymentDeclarationPanel } from './PaymentDeclarationPanel';

interface OrderWizardProps {
  services: PrintService[];
  paymentMethods: PaymentMethod[];
  settings: ShopSettings;
  clientAccount: ClientAccountPublic | null;
  preselectedServiceId?: string;
  initialReprintOrder?: Order | null;
  onClientAuthenticated: (account: ClientAccountPublic, claimedOrder?: Order) => void;
  onOrderCreatedAndTrack: (order: Order) => void;
  onOrderUpdated?: (order: Order) => void;
  onBackHome: () => void;
}

const DRAFT_STORAGE_KEY = 'fbc_print_order_draft_v1';

export const OrderWizard: React.FC<OrderWizardProps> = ({
  services,
  paymentMethods,
  settings,
  clientAccount,
  preselectedServiceId,
  initialReprintOrder,
  onClientAuthenticated,
  onOrderCreatedAndTrack,
  onOrderUpdated,
  onBackHome,
}) => {
  const activeServices = useMemo(() => services.filter((s) => s.active), [services]);

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  // Step 1: Coordinates
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [isWhatsapp, setIsWhatsapp] = useState(true);
  const [wantsDelivery, setWantsDelivery] = useState(false);
  const [deliveryZoneId, setDeliveryZoneId] = useState(
    settings.deliveryZones[0]?.id || ''
  );
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Step 2: Cart + Current Service Configurator
  const [cartItems, setCartItems] = useState<OrderItem[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>(
    preselectedServiceId || activeServices[0]?.id || ''
  );

  // Configurator form states
  const [qty, setQty] = useState<number>(1);
  const [width, setWidth] = useState<number>(100);
  const [height, setHeight] = useState<number>(100);
  const [unit, setUnit] = useState<'cm' | 'm'>('cm');
  const [standardFormat, setStandardFormat] = useState<string>('A4');
  const [kakemonoPreset, setKakemonoPreset] = useState<string>('80 × 200 cm (Standard)');
  const [kakemonoCustom, setKakemonoCustom] = useState<boolean>(false);
  const [sides, setSides] = useState<'recto' | 'recto_verso'>('recto');
  const [pageCount, setPageCount] = useState<number>(8);
  const [apparelConfigs, setApparelConfigs] = useState<
    Record<
      ApparelType,
      {
        tech: ApparelPrintTech;
        disposition: ApparelDisposition;
        sizes: Record<string, number>;
      }
    >
  >({
    polo: {
      tech: 'dtf',
      disposition: 'poitrine_gauche',
      sizes: { XS: 0, S: 0, M: 1, L: 0, XL: 0, XXL: 0 },
    },
    tshirt: {
      tech: 'dtf',
      disposition: 'poitrine_gauche',
      sizes: { XS: 0, S: 0, M: 1, L: 0, XL: 0, XXL: 0 },
    },
    casquette: {
      tech: 'dtf',
      disposition: 'poitrine_gauche',
      sizes: { Unique: 1, Enfant: 0, S: 0, M: 0, L: 0 },
    },
  });
  const [selectedApparelTypes, setSelectedApparelTypes] = useState<ApparelType[]>(['polo']);
  const [teamName, setTeamName] = useState('');
  const [releaseYear, setReleaseYear] = useState('2026');
  const [jerseyQuality, setJerseyQuality] = useState('standard');
  const [jerseyRows, setJerseyRows] = useState<JerseyRow[]>([
    { id: 'jr_1', backName: '', number: '10', size: 'L', quantity: 1 },
  ]);
  const [itemNotes, setItemNotes] = useState('');
  const [step2Error, setStep2Error] = useState<string | null>(null);

  // Step 3: Uploaded files
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileMeta[]>([]);
  const [uploadProgressMap, setUploadProgressMap] = useState<
    Record<string, UploadProgressState>
  >({});
  const controllersRef = useRef<Record<string, ResumableUploadController>>({});
  const [step3Error, setStep3Error] = useState<string | null>(null);

  // Step 4 & 5: Terms, submission & created order
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdOrder, setCreatedOrder] = useState<Order | null>(null);
  const [showPaymentBox, setShowPaymentBox] = useState(false);
  const [copiedTracking, setCopiedTracking] = useState(false);
  const [showStickyBreakdown, setShowStickyBreakdown] = useState(false);

  // Load draft or reprint prefill
  useEffect(() => {
    if (initialReprintOrder) {
      setCustomerName(initialReprintOrder.customerName);
      setCustomerPhone(initialReprintOrder.customerPhone);
      setIsWhatsapp(initialReprintOrder.isWhatsapp);
      setWantsDelivery(initialReprintOrder.wantsDelivery);
      setDeliveryAddress(initialReprintOrder.deliveryAddress || '');
      setCartItems(initialReprintOrder.items);
      setStep(3);
      return;
    }

    try {
      const saved = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.customerName) setCustomerName(parsed.customerName);
        if (parsed.customerPhone) setCustomerPhone(parsed.customerPhone);
        if (typeof parsed.isWhatsapp === 'boolean') setIsWhatsapp(parsed.isWhatsapp);
        if (typeof parsed.wantsDelivery === 'boolean') setWantsDelivery(parsed.wantsDelivery);
        if (parsed.deliveryAddress) setDeliveryAddress(parsed.deliveryAddress);
        if (Array.isArray(parsed.cartItems) && parsed.cartItems.length > 0) {
          setCartItems(parsed.cartItems);
        }
      }
    } catch {
      // ignore localStorage read failure
    }
  }, [initialReprintOrder]);

  // Pre-fill coordinates from authenticated client account when empty
  useEffect(() => {
    if (clientAccount) {
      setCustomerName((prev) => (prev.trim() ? prev : clientAccount.fullName));
      setCustomerPhone((prev) => (prev.trim() ? prev : clientAccount.phone));
    }
  }, [clientAccount]);

  // Preselect service if passed from home card
  useEffect(() => {
    if (preselectedServiceId) {
      setSelectedServiceId(preselectedServiceId);
      const found = activeServices.find((s) => s.id === preselectedServiceId);
      if (found && isApparelSlug(found.slug)) {
        setSelectedApparelTypes([getApparelTypeFromSlug(found.slug)]);
      }
    }
  }, [preselectedServiceId, activeServices]);

  // Save draft continuously
  useEffect(() => {
    if (createdOrder) return;
    try {
      localStorage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify({
          customerName,
          customerPhone,
          isWhatsapp,
          wantsDelivery,
          deliveryAddress,
          cartItems,
        })
      );
    } catch {
      // ignore quota
    }
  }, [customerName, customerPhone, isWhatsapp, wantsDelivery, deliveryAddress, cartItems, createdOrder]);

  const currentService =
    activeServices.find((s) => s.id === selectedServiceId) || activeServices[0];

  const apparelServicesMap = useMemo(() => {
    const map: Partial<Record<ApparelType, PrintService>> = {};
    for (const s of activeServices) {
      if (s.slug === 'polo' || s.slug === 'tshirt' || s.slug === 'casquette') {
        map[s.slug] = s;
      }
    }
    return map;
  }, [activeServices]);

  const availableApparelTypes = useMemo(() => {
    const list = (['polo', 'tshirt', 'casquette'] as ApparelType[]).filter(
      (t) => Boolean(apparelServicesMap[t])
    );
    return list.length > 0 ? list : (['polo', 'tshirt', 'casquette'] as ApparelType[]);
  }, [apparelServicesMap]);

  // Reset sensible defaults when switching service
  const handleSelectService = (srv: PrintService) => {
    setSelectedServiceId(srv.id);
    setStep2Error(null);
    if (isApparelSlug(srv.slug)) {
      const targetType = getApparelTypeFromSlug(srv.slug);
      setSelectedApparelTypes([targetType]);
    } else if (srv.slug === 'carte_visite') {
      setQty(100);
      setSides('recto');
    } else if (srv.slug === 'etiquettes') {
      setQty(100);
      setWidth(8);
      setHeight(5);
    } else if (srv.slug === 'kakemono') {
      setQty(1);
      setKakemonoCustom(false);
      setKakemonoPreset(srv.config?.kakemonoSizes?.[0]?.label || '80 × 200 cm (Standard)');
    } else if (srv.slug === 'catalogue') {
      setQty(50);
      setPageCount(8);
      setSides('recto_verso');
    } else if (srv.slug === 'grand_format') {
      setQty(1);
      setUnit('m');
      setWidth(2);
      setHeight(1);
    } else if (srv.slug === 'portrait') {
      setQty(1);
      setUnit('cm');
      setWidth(60);
      setHeight(80);
    } else {
      setQty(1);
    }
  };

  const toggleApparelChoice = (art: ApparelType) => {
    setStep2Error(null);
    setSelectedApparelTypes((prev) => {
      if (prev.includes(art)) {
        if (prev.length === 1) return prev; // Keep at least one selected
        return prev.filter((x) => x !== art);
      }
      return [...prev, art];
    });
  };

  const getServiceForApparelType = (art: ApparelType): PrintService | undefined => {
    return apparelServicesMap[art] || currentService;
  };

  const apparelPreviews = useMemo(() => {
    if (!currentService || !isApparelSlug(currentService.slug)) return [];
    return selectedApparelTypes.map((art) => {
      const srv = apparelServicesMap[art] || currentService;
      const cfg = apparelConfigs[art];
      const totalSizesQty = Object.values(cfg.sizes).reduce(
        (sum, n) => sum + Math.max(0, Number(n) || 0),
        0
      );
      const pricing = calculateItemPricing(srv, {
        quantity: Math.max(1, totalSizesQty),
        apparelTech: cfg.tech,
        apparelType: art,
        apparelDisposition: art === 'casquette' ? 'poitrine_gauche' : cfg.disposition,
        apparelSizes: cfg.sizes,
      });
      return {
        art,
        service: srv,
        config: cfg,
        totalSizesQty,
        pricing,
      };
    });
  }, [currentService, selectedApparelTypes, apparelServicesMap, apparelConfigs]);

  const draftItemPreview = useMemo(() => {
    if (!currentService) return null;
    if (isApparelSlug(currentService.slug)) {
      if (apparelPreviews.length === 0) return null;
      const totalSub = apparelPreviews.reduce((s, p) => s + p.pricing.subtotal, 0);
      const totalPieces = apparelPreviews.reduce((s, p) => s + p.totalSizesQty, 0);
      const names = apparelPreviews
        .map((p) => `${APPAREL_TYPE_LABELS[p.art]} (${p.totalSizesQty})`)
        .join(' + ');
      return {
        unitPrice: apparelPreviews[0].pricing.unitPrice,
        subtotal: totalSub,
        summaryText: `${names} · ${totalPieces} pièce(s) au total`,
      };
    }

    const draft: Partial<OrderItem> = {
      quantity: qty,
      width,
      height,
      unit,
      standardFormat,
      kakemonoPreset: kakemonoCustom ? undefined : kakemonoPreset,
      sides,
      pageCount,
      teamName,
      releaseYear,
      jerseyQuality,
      jerseyRows,
      notes: itemNotes,
    };
    return calculateItemPricing(currentService, draft);
  }, [
    currentService,
    apparelPreviews,
    qty,
    width,
    height,
    unit,
    standardFormat,
    kakemonoCustom,
    kakemonoPreset,
    sides,
    pageCount,
    teamName,
    releaseYear,
    jerseyQuality,
    jerseyRows,
    itemNotes,
  ]);

  const buildOrderItemsFromCurrent = (): { items: OrderItem[]; error?: string } => {
    if (!currentService || !draftItemPreview) {
      return { items: [], error: 'Veuillez sélectionner une prestation.' };
    }

    if (isApparelSlug(currentService.slug)) {
      if (selectedApparelTypes.length === 0) {
        return {
          items: [],
          error: 'Sélectionnez au moins un article (Polo, T-shirt ou Casquette).',
        };
      }
      const builtItems: OrderItem[] = [];
      for (const art of selectedApparelTypes) {
        const srv = getServiceForApparelType(art);
        if (!srv) continue;
        const cfg = apparelConfigs[art];
        const cleanSizes: Record<string, number> = {};
        let totalSizesQty = 0;
        for (const sz of APPAREL_SIZE_OPTIONS[art]) {
          const val = Math.max(0, Math.round(Number(cfg.sizes[sz]) || 0));
          if (val > 0) {
            cleanSizes[sz] = val;
            totalSizesQty += val;
          }
        }
        if (totalSizesQty <= 0) {
          return {
            items: [],
            error: `Indiquez la quantité pour au moins une taille sur : ${APPAREL_TYPE_LABELS[art]}.`,
          };
        }
        const pricing = calculateItemPricing(srv, {
          quantity: totalSizesQty,
          apparelTech: cfg.tech,
          apparelType: art,
          apparelDisposition: art === 'casquette' ? 'poitrine_gauche' : cfg.disposition,
          apparelSizes: cleanSizes,
        });
        const item: OrderItem = {
          itemId: `itm_${Date.now()}_${art}_${Math.random().toString(36).slice(2, 6)}`,
          serviceId: srv.id,
          serviceSlug: srv.slug,
          serviceName: srv.name,
          quantity: totalSizesQty,
          apparelTech: cfg.tech,
          apparelType: art,
          apparelDisposition: art === 'casquette' ? 'poitrine_gauche' : cfg.disposition,
          apparelSizes: cleanSizes,
          unitPrice: pricing.unitPrice,
          subtotal: pricing.subtotal,
          summaryText: pricing.summaryText,
        };
        if (itemNotes.trim()) {
          item.notes = itemNotes.trim();
        }
        builtItems.push(item);
      }
      return { items: builtItems };
    }

    let effectiveQty = Math.max(1, qty);
    if (currentService.slug === 'maillot') {
      effectiveQty = jerseyRows.reduce((s, r) => s + Math.max(1, Number(r.quantity) || 1), 0);
    }

    const item: OrderItem = {
      itemId: `itm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      serviceId: currentService.id,
      serviceSlug: currentService.slug,
      serviceName: currentService.name,
      quantity: effectiveQty,
      unitPrice: draftItemPreview.unitPrice,
      subtotal: draftItemPreview.subtotal,
      summaryText: draftItemPreview.summaryText,
    };

    if (
      currentService.slug === 'grand_format' ||
      currentService.slug === 'portrait' ||
      currentService.slug === 'etiquettes' ||
      currentService.slug === 'catalogue' ||
      (currentService.slug === 'kakemono' && kakemonoCustom)
    ) {
      item.width = width;
      item.height = height;
      item.unit = currentService.slug === 'grand_format' ? unit : 'cm';
    }
    if (currentService.slug === 'format_standard') {
      item.standardFormat = standardFormat;
    }
    if (currentService.slug === 'kakemono' && !kakemonoCustom) {
      item.kakemonoPreset = kakemonoPreset;
    }
    if (currentService.slug === 'carte_visite' || currentService.slug === 'catalogue') {
      item.sides = sides;
    }
    if (currentService.slug === 'catalogue') {
      item.pageCount = pageCount;
    }
    if (currentService.slug === 'maillot') {
      item.teamName = teamName;
      item.releaseYear = releaseYear;
      item.jerseyQuality = jerseyQuality;
      item.jerseyRows = jerseyRows;
    }
    if (itemNotes.trim()) {
      item.notes = itemNotes.trim();
    }

    return { items: [item] };
  };

  const handleAddToCart = () => {
    setStep2Error(null);
    const { items, error } = buildOrderItemsFromCurrent();
    if (error || items.length === 0) {
      setStep2Error(error || 'Veuillez configurer au moins une prestation.');
      return;
    }
    setCartItems((prev) => [...prev, ...items]);
    setItemNotes('');
  };

  const handleContinueFromStep2 = () => {
    setStep2Error(null);
    if (cartItems.length === 0) {
      const { items, error } = buildOrderItemsFromCurrent();
      if (error || items.length === 0) {
        setStep2Error(error || 'Veuillez configurer au moins une prestation.');
        return;
      }
      setCartItems(items);
    }
    setStep(3);
  };

  // Validate Step 1
  const handleStep1Next = (e: React.FormEvent) => {
    e.preventDefault();
    setStep1Error(null);
    if (!clientAccount) {
      setStep1Error('Veuillez créer votre compte client ou vous connecter ci-dessus pour sécuriser votre commande.');
      return;
    }
    if (customerName.trim().length < 2) {
      setStep1Error('Veuillez renseigner votre nom complet.');
      return;
    }
    const check = normalizeBurkinaPhone(customerPhone);
    if (!check.valid) {
      setStep1Error(check.error || 'Numéro de téléphone invalide.');
      return;
    }
    setCustomerPhone(check.normalized);
    if (wantsDelivery && deliveryAddress.trim().length < 3) {
      setStep1Error('Veuillez indiquer votre adresse ou quartier de livraison.');
      return;
    }
    setStep(2);
  };

  // File upload handler for a specific item + slot
  const handleSlotFileUpload = async (
    item: OrderItem,
    slotKey: string,
    slotLabel: string,
    file: File
  ) => {
    setStep3Error(null);
    const ext = `.${file.name.split('.').pop()?.toLowerCase() || ''}`;
    const allowed = settings.allowedExtensions.map((e) => e.toLowerCase());
    if (!allowed.includes(ext)) {
      setStep3Error(
        `Format ${ext || 'inconnu'} non autorisé. Extensions acceptées : ${settings.allowedExtensions.join(', ')}`
      );
      return;
    }
    if (file.size <= 0) {
      setStep3Error('Le fichier sélectionné est vide.');
      return;
    }
    if (file.size > settings.maxFileSizeMb * 1024 * 1024) {
      setStep3Error(
        `Le fichier dépasse la taille maximale autorisée (${settings.maxFileSizeMb} Mo).`
      );
      return;
    }

    const progressKey = `${item.itemId}__${slotKey}`;
    const { promise, controller } = startResumableUpload(
      file,
      {
        itemId: item.itemId,
        slotKey,
        slotLabel,
        version: 1,
        purpose: 'order_file',
        authMode: 'client',
      },
      (st) => {
        setUploadProgressMap((prev) => ({ ...prev, [progressKey]: st }));
      }
    );
    controllersRef.current[progressKey] = controller;

    try {
      const meta = await promise;
      const dpiInfo = estimatePrintDpi(meta, item);
      const enriched: UploadedFileMeta = {
        ...meta,
        ...(typeof dpiInfo.estimatedDpi === 'number'
          ? { estimatedDpi: dpiInfo.estimatedDpi }
          : {}),
        lowQualityWarning: dpiInfo.lowQualityWarning,
      };
      setUploadedFiles((prev) => [
        ...prev.filter((f) => !(f.itemId === item.itemId && f.slotKey === slotKey)),
        enriched,
      ]);
    } catch (err) {
      setStep3Error(
        err instanceof Error ? err.message : 'Erreur lors du transfert du fichier.'
      );
    }
  };

  const removeUploadedSlotFile = (itemId: string, slotKey: string) => {
    const progressKey = `${itemId}__${slotKey}`;
    controllersRef.current[progressKey]?.cancel();
    setUploadedFiles((prev) =>
      prev.filter((f) => !(f.itemId === itemId && f.slotKey === slotKey))
    );
    setUploadProgressMap((prev) => {
      const next = { ...prev };
      delete next[progressKey];
      return next;
    });
  };

  // Validate all required file slots across cart items
  const allRequiredSlotsMet = useMemo(() => {
    if (cartItems.length === 0) return false;
    for (const item of cartItems) {
      const slots = getRequiredSlotsForItem(item);
      for (const s of slots) {
        if (!s.required) continue;
        const found = uploadedFiles.find(
          (f) => f.itemId === item.itemId && f.slotKey === s.slotKey
        );
        if (!found) return false;
      }
    }
    return true;
  }, [cartItems, uploadedFiles]);

  // Pricing Totals
  const subtotal = useMemo(
    () => cartItems.reduce((sum, item) => sum + item.subtotal, 0),
    [cartItems]
  );
  const selectedZone = settings.deliveryZones.find((z) => z.id === deliveryZoneId);
  const deliveryFee = wantsDelivery && selectedZone ? selectedZone.fee : 0;
  const urgentFee = urgent
    ? Math.round((subtotal * (settings.urgentSurchargePercent || 25)) / 100)
    : 0;
  const totalAmount = subtotal + deliveryFee + urgentFee;
  const depositRequiredAmount = Math.round(
    (totalAmount * (settings.depositPercent || 70)) / 100
  );

  // Real-time floating estimate across steps 1-4
  const liveItemsSubtotal = useMemo(() => {
    if (cartItems.length > 0) return subtotal;
    if (step === 2 && draftItemPreview) return draftItemPreview.subtotal;
    return 0;
  }, [cartItems.length, subtotal, step, draftItemPreview]);

  const liveUrgentFee = urgent
    ? Math.round((liveItemsSubtotal * (settings.urgentSurchargePercent || 25)) / 100)
    : 0;
  const liveEstimatedTotal = liveItemsSubtotal + deliveryFee + liveUrgentFee;
  const liveDepositAmount = Math.round(
    (liveEstimatedTotal * (settings.depositPercent || 70)) / 100
  );
  const liveItemsCount =
    cartItems.length > 0
      ? cartItems.length
      : step === 2 && currentService
        ? isApparelSlug(currentService.slug)
          ? selectedApparelTypes.length
          : 1
        : 0;
  const stepProgressPercent = Math.min(100, step * 25);
  const stepShortTitles: Record<1 | 2 | 3 | 4 | 5, string> = {
    1: 'Coordonnées',
    2: 'Impression',
    3: 'Fichiers',
    4: 'Validation',
    5: 'Confirmation',
  };

  // Final Order Submission
  const handleFinalSubmit = async () => {
    setSubmitError(null);
    if (!acceptedTerms) {
      setSubmitError('Veuillez accepter les conditions de commande avant de valider.');
      return;
    }
    setSubmittingOrder(true);
    try {
      const validUntilDate = new Date();
      validUntilDate.setDate(validUntilDate.getDate() + (settings.quoteValidityDays || 15));

      const orderPayload = {
        customerName: customerName.trim(),
        customerPhone: normalizeBurkinaPhone(customerPhone).normalized,
        isWhatsapp,
        wantsDelivery,
        deliveryZoneId: wantsDelivery && selectedZone ? selectedZone.id : '',
        deliveryZoneName: wantsDelivery && selectedZone ? selectedZone.name : '',
        deliveryAddress: wantsDelivery ? deliveryAddress.trim() : '',
        deliveryFee,
        urgent,
        urgentFee,
        discountAmount: 0,
        subtotal,
        totalAmount,
        depositRequiredAmount,
        paidAmount: 0,
        status: 'recue' as const,
        paymentStatus: 'non_paye' as const,
        acceptedTerms: true,
        quoteValidUntil: validUntilDate.toISOString(),
        items: cartItems,
        files: uploadedFiles,
        statusHistory: [],
        source: 'web' as const,
      };

      const created = await createClientOrder(orderPayload);
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      setCreatedOrder(created);
      onOrderUpdated?.(created);
      setStep(5);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Impossible d’enregistrer la commande. Vérifiez votre connexion.'
      );
    } finally {
      setSubmittingOrder(false);
    }
  };

  if (!settings.isOpen) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-14 text-center space-y-6">
        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm space-y-4">
          <img
            src="/assets/aistudio/logo_vertical_1804a5ee.svg"
            alt="FBC Print"
            className="h-24 mx-auto"
          />
          <h1 className="font-display text-2xl text-[#26547C]">
            Prise de commandes temporairement fermée
          </h1>
          <p className="text-base text-slate-700">{settings.closedMessage}</p>
          <button
            type="button"
            onClick={onBackHome}
            className="px-6 py-3 rounded-full bg-[#26547C] text-white font-semibold text-sm min-h-[44px]"
          >
            Retour à l’accueil
          </button>
        </div>
      </div>
    );
  }

  const STEP_LABELS = [
    '1. Coordonnées',
    '2. Impression',
    '3. Fichiers',
    '4. Validation',
    '5. Devis & Paiement',
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Progress Bar */}
      <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between gap-2 overflow-x-auto no-scrollbar">
          {STEP_LABELS.map((label, idx) => {
            const stepNum = (idx + 1) as 1 | 2 | 3 | 4 | 5;
            const active = step === stepNum;
            const done = step > stepNum;
            return (
              <div
                key={label}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#26547C] text-white'
                    : done
                      ? 'bg-[#119DA4]/15 text-[#0E7F85]'
                      : 'text-slate-500'
                }`}
              >
                {done && <Check className="w-3.5 h-3.5" />}
                <span>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* STEP 1: Coordinates & Client Account */}
      {step === 1 && (
        <div className="space-y-6">
          {!clientAccount ? (
            <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-5">
              <div>
                <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
                  Votre compte client &amp; coordonnées
                </h1>
                <p className="text-sm text-slate-600 mt-1">
                  Créez votre compte ou connectez-vous en 30 secondes pour protéger vos fichiers, retrouver toutes vos commandes et recevoir le suivi privé.
                </p>
              </div>
              <ClientAuthPanel
                compact
                initialMode="register"
                shopWhatsapp={settings.whatsapp}
                onAuthenticated={(acc, claimed) => {
                  onClientAuthenticated(acc, claimed);
                  setCustomerName(acc.fullName);
                  setCustomerPhone(acc.phone);
                  setStep1Error(null);
                }}
              />
            </div>
          ) : (
            <form
              onSubmit={handleStep1Next}
              className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-6"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
                    Vos coordonnées
                  </h1>
                  <p className="text-sm text-slate-600 mt-1">
                    Connecté en tant que{' '}
                    <strong className="text-[#26547C]">@{clientAccount.username}</strong> — vos fichiers et votre suivi restent strictement privés.
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#2E9E6B]/15 text-[#237A52] text-xs font-semibold self-start">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Compte vérifié
                </span>
              </div>

              <div className="grid sm:grid-cols-2 gap-5">
                <div>
                  <label
                    htmlFor="cust-name"
                    className="block text-sm font-semibold text-[#26547C] mb-1.5"
                  >
                    Nom complet ou Entreprise *
                  </label>
                  <input
                    id="cust-name"
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Ex : Moussa Ouattara / Faso Design"
                    className="w-full px-4 py-3.5 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="cust-phone"
                    className="block text-sm font-semibold text-[#26547C] mb-1.5"
                  >
                    Téléphone (Burkina Faso +226) *
                  </label>
                  <input
                    id="cust-phone"
                    type="tel"
                    required
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="+226 74 67 77 08"
                    className="w-full px-4 py-3.5 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
                  />
                  <label className="mt-2 inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isWhatsapp}
                      onChange={(e) => setIsWhatsapp(e.target.checked)}
                      className="w-4 h-4 accent-[#119DA4] rounded"
                    />
                    Ce numéro est actif sur WhatsApp (recommandé pour le lien de suivi)
                  </label>
                </div>
              </div>

          <div className="pt-2 border-t border-slate-100 space-y-4">
            <label className="flex items-center gap-3 cursor-pointer p-4 rounded-2xl bg-[#EDF2F4]/70 hover:bg-[#EDF2F4]">
              <input
                type="checkbox"
                checked={wantsDelivery}
                onChange={(e) => setWantsDelivery(e.target.checked)}
                className="w-5 h-5 accent-[#119DA4] rounded"
              />
              <div>
                <div className="font-semibold text-base text-[#26547C]">
                  Je souhaite être livré
                </div>
                <div className="text-xs text-slate-600">
                  Décochez pour un retrait gratuit à l’agence ({settings.address}).
                </div>
              </div>
            </label>

            {wantsDelivery && (
              <div className="grid sm:grid-cols-2 gap-4 pl-2">
                <div>
                  <label
                    htmlFor="del-zone"
                    className="block text-sm font-semibold text-[#26547C] mb-1.5"
                  >
                    Zone de livraison
                  </label>
                  <select
                    id="del-zone"
                    value={deliveryZoneId}
                    onChange={(e) => setDeliveryZoneId(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white text-base min-h-[44px]"
                  >
                    {settings.deliveryZones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name} (+{formatFcfa(z.fee)})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="del-addr"
                    className="block text-sm font-semibold text-[#26547C] mb-1.5"
                  >
                    Adresse précise / Secteur / Repère *
                  </label>
                  <input
                    id="del-addr"
                    type="text"
                    value={deliveryAddress}
                    onChange={(e) => setDeliveryAddress(e.target.value)}
                    placeholder="Ex : Secteur 18, près du marché"
                    className="w-full px-4 py-3.5 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white text-base min-h-[44px]"
                  />
                </div>
              </div>
            )}

            <label className="flex items-center gap-3 cursor-pointer p-4 rounded-2xl border border-slate-200">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(e) => setUrgent(e.target.checked)}
                className="w-5 h-5 accent-[#EF233C] rounded"
              />
              <div>
                <div className="font-semibold text-base text-[#26547C]">
                  Traitement prioritaire / Urgent (+{settings.urgentSurchargePercent}%)
                </div>
                <div className="text-xs text-slate-600">
                  Passage en tête de file à l’atelier dès validation du paiement.
                </div>
              </div>
            </label>
          </div>

          {step1Error && (
            <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
              {step1Error}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] min-h-[48px]"
            >
              Choisir l’impression
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </form>
          )}
        </div>
      )}

      {/* STEP 2: Print Type & Dynamic Specifications */}
      {step === 2 && currentService && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-6">
            <div>
              <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
                Type d’impression et caractéristiques
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Choisissez une prestation puis renseignez vos dimensions et quantités.
              </p>
            </div>

            {/* Illustrated Service Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {activeServices.map((srv) => {
                const isApparelActive =
                  isApparelSlug(currentService.slug) &&
                  isApparelSlug(srv.slug) &&
                  selectedApparelTypes.includes(getApparelTypeFromSlug(srv.slug));
                const selected = srv.id === currentService.id || isApparelActive;
                const imgSrc = getServiceImageSrc(srv);
                return (
                  <button
                    key={srv.id}
                    type="button"
                    onClick={() => handleSelectService(srv)}
                    className={`rounded-2xl overflow-hidden border-2 text-left transition-all flex flex-col ${
                      selected
                        ? 'border-[#26547C] ring-2 ring-[#119DA4]/30 bg-[#EDF2F4]/50'
                        : 'border-slate-200 hover:border-[#119DA4]/60 bg-white'
                    }`}
                  >
                    <div className="h-20 w-full bg-[#EDF2F4] overflow-hidden relative">
                      <img
                        src={imgSrc}
                        alt={srv.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="p-2.5">
                      <div className="text-xs sm:text-sm font-bold text-[#26547C] leading-tight">
                        {srv.name}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                        Dès {formatFcfa(srv.basePrice)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Dynamic Fields per Service Type (Section 4.3) */}
            <div className="pt-4 border-t border-slate-100 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <h2 className="font-bold text-lg text-[#26547C]">
                  Configuration : {currentService.name}
                </h2>
                <span className="text-xs font-medium text-[#119DA4]">
                  Résolution recommandée : {currentService.recommendedDpi} DPI
                </span>
              </div>

              {/* Grand format & Portrait */}
              {(currentService.slug === 'grand_format' ||
                currentService.slug === 'portrait') && (
                <div className="grid sm:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Largeur
                    </label>
                    <input
                      type="number"
                      min={1}
                      step="0.1"
                      value={width}
                      onChange={(e) => setWidth(Number(e.target.value))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Hauteur
                    </label>
                    <input
                      type="number"
                      min={1}
                      step="0.1"
                      value={height}
                      onChange={(e) => setHeight(Number(e.target.value))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                  {currentService.slug === 'grand_format' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Unité
                      </label>
                      <select
                        value={unit}
                        onChange={(e) => setUnit(e.target.value as 'cm' | 'm')}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      >
                        <option value="m">Mètres (m)</option>
                        <option value="cm">Centimètres (cm)</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Quantité
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={qty}
                      onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                </div>
              )}

              {/* Formats standards */}
              {currentService.slug === 'format_standard' && (
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Format standard
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {(currentService.config?.formats || []).map((f) => (
                        <button
                          key={f.name}
                          type="button"
                          onClick={() => setStandardFormat(f.name)}
                          className={`px-4 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border transition-colors ${
                            standardFormat === f.name
                              ? 'bg-[#26547C] text-white border-[#26547C]'
                              : 'bg-[#EDF2F4] text-[#26547C] border-transparent hover:border-[#119DA4]'
                          }`}
                        >
                          {f.name} ({formatFcfa(f.price)})
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Quantité d’exemplaires
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={qty}
                      onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                </div>
              )}

              {/* Kakemono */}
              {currentService.slug === 'kakemono' && (
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Dimensions du kakemono
                      </label>
                      <select
                        value={kakemonoCustom ? '__custom__' : kakemonoPreset}
                        onChange={(e) => {
                          if (e.target.value === '__custom__') {
                            setKakemonoCustom(true);
                          } else {
                            setKakemonoCustom(false);
                            setKakemonoPreset(e.target.value);
                          }
                        }}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      >
                        {(currentService.config?.kakemonoSizes || []).map((k) => (
                          <option key={k.label} value={k.label}>
                            {k.label} — {formatFcfa(k.price)}
                          </option>
                        ))}
                        <option value="__custom__">Dimensions personnalisées (cm)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Quantité
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={qty}
                        onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                    </div>
                  </div>

                  {kakemonoCustom && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Largeur (cm)
                        </label>
                        <input
                          type="number"
                          min={30}
                          value={width}
                          onChange={(e) => setWidth(Number(e.target.value))}
                          className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1">
                          Hauteur (cm)
                        </label>
                        <input
                          type="number"
                          min={50}
                          value={height}
                          onChange={(e) => setHeight(Number(e.target.value))}
                          className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Carte de visite */}
              {currentService.slug === 'carte_visite' && (
                <div className="space-y-4">
                  <div>
                    <span className="block text-sm font-medium text-slate-700 mb-1.5">
                      Impression des faces
                    </span>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setSides('recto')}
                        className={`px-5 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border ${
                          sides === 'recto'
                            ? 'bg-[#26547C] text-white border-[#26547C]'
                            : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                        }`}
                      >
                        Recto seul (1 fichier)
                      </button>
                      <button
                        type="button"
                        onClick={() => setSides('recto_verso')}
                        className={`px-5 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border ${
                          sides === 'recto_verso'
                            ? 'bg-[#26547C] text-white border-[#26547C]'
                            : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                        }`}
                      >
                        Recto-verso (2 fichiers)
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="block text-sm font-medium text-slate-700 mb-1.5">
                      Palier de quantité
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {(currentService.config?.quantityTiers || []).map((tier) => (
                        <button
                          key={tier.minQty}
                          type="button"
                          onClick={() => setQty(tier.minQty)}
                          className={`px-5 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border ${
                            qty === tier.minQty
                              ? 'bg-[#119DA4] text-white border-[#119DA4]'
                              : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                          }`}
                        >
                          {tier.minQty} cartes ({formatFcfa(tier.unitPrice)}/u)
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Catalogue / brochure */}
              {currentService.slug === 'catalogue' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => setSides('recto')}
                      className={`px-5 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border ${
                        sides === 'recto'
                          ? 'bg-[#26547C] text-white border-[#26547C]'
                          : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                      }`}
                    >
                      Recto seul
                    </button>
                    <button
                      type="button"
                      onClick={() => setSides('recto_verso')}
                      className={`px-5 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border ${
                        sides === 'recto_verso'
                          ? 'bg-[#26547C] text-white border-[#26547C]'
                          : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                      }`}
                    >
                      Recto-verso
                    </button>
                  </div>

                  <div className="grid sm:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Nombre de pages
                      </label>
                      <input
                        type="number"
                        min={4}
                        step={4}
                        value={pageCount}
                        onChange={(e) => setPageCount(Math.max(4, Number(e.target.value)))}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                      {pageCount % 4 !== 0 && (
                        <span className="text-xs text-[#EF233C] mt-1 block">
                          Conseil reliure : utilisez un multiple de 4 pages.
                        </span>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Exemplaires
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={qty}
                        onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Largeur cm (optionnel)
                      </label>
                      <input
                        type="number"
                        min={5}
                        value={width}
                        onChange={(e) => setWidth(Number(e.target.value))}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Hauteur cm (optionnel)
                      </label>
                      <input
                        type="number"
                        min={5}
                        value={height}
                        onChange={(e) => setHeight(Number(e.target.value))}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Textile Multi-Select: Polo, T-shirt, Casquette */}
              {isApparelSlug(currentService.slug) && (
                <div className="space-y-6">
                  <div className="rounded-2xl bg-[#EDF2F4]/70 p-4 border border-slate-200/80 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="block text-sm font-bold text-[#26547C]">
                          Sélection multiple : Polo, T-shirt et/ou Casquette
                        </span>
                        <span className="text-xs text-slate-600">
                          Cochez un ou plusieurs supports ci-dessous pour les configurer ensemble avec leurs tailles respectives.
                        </span>
                      </div>
                      <span className="text-xs font-semibold text-[#119DA4]">
                        {selectedApparelTypes.length} support
                        {selectedApparelTypes.length > 1 ? 's' : ''} sélectionné
                        {selectedApparelTypes.length > 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="grid sm:grid-cols-3 gap-3">
                      {availableApparelTypes.map((art) => {
                        const srv = getServiceForApparelType(art);
                        const isChecked = selectedApparelTypes.includes(art);
                        return (
                          <button
                            key={art}
                            type="button"
                            onClick={() => toggleApparelChoice(art)}
                            className={`flex items-center gap-3 p-3 rounded-2xl border-2 text-left transition-all ${
                              isChecked
                                ? 'bg-white border-[#119DA4] shadow-sm'
                                : 'bg-white/60 border-slate-200 hover:border-[#119DA4]/50'
                            }`}
                          >
                            <div
                              className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border ${
                                isChecked
                                  ? 'bg-[#119DA4] border-[#119DA4] text-white'
                                  : 'bg-white border-slate-300'
                              }`}
                            >
                              {isChecked && <Check className="w-3.5 h-3.5" />}
                            </div>
                            {srv && (
                              <img
                                src={getServiceImageSrc(srv)}
                                alt={srv.name}
                                referrerPolicy="no-referrer"
                                className="w-11 h-11 rounded-xl object-cover bg-[#EDF2F4] shrink-0"
                              />
                            )}
                            <div className="min-w-0">
                              <div className="text-sm font-bold text-[#26547C] truncate">
                                {srv?.name || APPAREL_TYPE_LABELS[art]}
                              </div>
                              <div className="text-xs text-slate-500 tabular-nums">
                                Base : {formatFcfa(srv?.basePrice ?? 3500)}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Per-selected-article configuration card */}
                  <div className="space-y-5">
                    {selectedApparelTypes.map((art) => {
                      const srv = getServiceForApparelType(art);
                      const cfg = apparelConfigs[art];
                      const sizeOptions = APPAREL_SIZE_OPTIONS[art];
                      const articleQtyTotal = Object.values(cfg.sizes).reduce(
                        (s, n) => s + Math.max(0, Number(n) || 0),
                        0
                      );
                      const previewPricing = srv
                        ? calculateItemPricing(srv, {
                            quantity: Math.max(1, articleQtyTotal),
                            apparelTech: cfg.tech,
                            apparelType: art,
                            apparelDisposition:
                              art === 'casquette' ? 'poitrine_gauche' : cfg.disposition,
                            apparelSizes: cfg.sizes,
                          })
                        : null;

                      const dtfAdd = srv?.config?.apparelTechPrices?.dtf ?? 1000;
                      const subAdd = srv?.config?.apparelTechPrices?.sublimation ?? 750;

                      return (
                        <div
                          key={art}
                          className="rounded-3xl border-2 border-[#26547C]/15 bg-white p-5 space-y-5 shadow-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                            <div className="flex items-center gap-3">
                              {srv && (
                                <img
                                  src={getServiceImageSrc(srv)}
                                  alt={srv.name}
                                  referrerPolicy="no-referrer"
                                  className="w-12 h-12 rounded-xl object-cover bg-[#EDF2F4]"
                                />
                              )}
                              <div>
                                <h3 className="font-bold text-base text-[#26547C]">
                                  {srv?.name || APPAREL_TYPE_LABELS[art]}
                                </h3>
                                <p className="text-xs text-slate-500">
                                  {articleQtyTotal} pièce{articleQtyTotal > 1 ? 's' : ''} ·{' '}
                                  {previewPricing
                                    ? `${formatFcfa(previewPricing.unitPrice)} / unité`
                                    : ''}
                                </p>
                              </div>
                            </div>
                            {previewPricing && articleQtyTotal > 0 && (
                              <div className="text-right">
                                <span className="text-xs text-slate-500 block">Sous-total</span>
                                <span className="text-lg font-bold text-[#26547C] tabular-nums">
                                  {formatFcfa(previewPricing.subtotal)}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Technique */}
                          <div>
                            <span className="block text-sm font-medium text-slate-700 mb-1.5">
                              Technique d’impression ({APPAREL_TYPE_LABELS[art]})
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {(['dtf', 'sublimation'] as ApparelPrintTech[]).map((tech) => {
                                const surcharge = tech === 'dtf' ? dtfAdd : subAdd;
                                return (
                                  <button
                                    key={tech}
                                    type="button"
                                    onClick={() =>
                                      setApparelConfigs((prev) => ({
                                        ...prev,
                                        [art]: { ...prev[art], tech },
                                      }))
                                    }
                                    className={`px-5 py-2.5 rounded-full text-sm font-semibold min-h-[44px] border ${
                                      cfg.tech === tech
                                        ? 'bg-[#26547C] text-white border-[#26547C]'
                                        : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                                    }`}
                                  >
                                    {tech.toUpperCase()} (+{formatFcfa(surcharge)})
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Disposition + Diagram */}
                          <div className="grid lg:grid-cols-12 gap-5 items-center">
                            <div className="lg:col-span-7 space-y-2">
                              {art === 'casquette' ? (
                                <div className="rounded-2xl bg-[#EDF2F4]/80 p-4 text-sm text-[#26547C]">
                                  <div className="font-semibold">
                                    Emplacement : Face avant de la casquette
                                  </div>
                                  <p className="text-xs text-slate-600 mt-1">
                                    Un emplacement principal face avant est inclus ({formatFcfa(srv?.config?.apparelPlacementPrice ?? 1000)}).
                                  </p>
                                </div>
                              ) : (
                                <>
                                  <span className="block text-sm font-medium text-slate-700">
                                    Disposition des visuels (les emplacements requis s’adapteront à l’étape 3)
                                  </span>
                                  <div className="grid sm:grid-cols-2 gap-2">
                                    {(
                                      Object.keys(APPAREL_DISPOSITION_LABELS) as ApparelDisposition[]
                                    ).map((disp) => (
                                      <button
                                        key={disp}
                                        type="button"
                                        onClick={() =>
                                          setApparelConfigs((prev) => ({
                                            ...prev,
                                            [art]: { ...prev[art], disposition: disp },
                                          }))
                                        }
                                        className={`px-4 py-2.5 rounded-2xl text-left text-xs sm:text-sm font-semibold border min-h-[44px] ${
                                          cfg.disposition === disp
                                            ? 'bg-[#26547C] text-white border-[#26547C]'
                                            : 'bg-[#EDF2F4] text-[#26547C] border-transparent'
                                        }`}
                                      >
                                        {APPAREL_DISPOSITION_LABELS[disp]}
                                      </button>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                            <div className="lg:col-span-5">
                              <ApparelDiagram
                                article={art}
                                disposition={
                                  art === 'casquette' ? 'poitrine_gauche' : cfg.disposition
                                }
                              />
                            </div>
                          </div>

                          {/* Quantities per size */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-semibold text-[#26547C]">
                                Quantité par taille ({APPAREL_TYPE_LABELS[art]})
                              </span>
                              <span className="text-xs font-bold text-[#119DA4] tabular-nums">
                                Total : {articleQtyTotal} pièce{articleQtyTotal > 1 ? 's' : ''}
                              </span>
                            </div>
                            <div
                              className={`grid gap-2 ${
                                sizeOptions.length === 6
                                  ? 'grid-cols-3 sm:grid-cols-6'
                                  : 'grid-cols-3 sm:grid-cols-5'
                              }`}
                            >
                              {sizeOptions.map((sz) => (
                                <div
                                  key={sz}
                                  className={`rounded-2xl p-2.5 text-center border ${
                                    (cfg.sizes[sz] ?? 0) > 0
                                      ? 'bg-[#119DA4]/10 border-[#119DA4]/40'
                                      : 'bg-[#EDF2F4] border-transparent'
                                  }`}
                                >
                                  <span className="block text-xs font-bold text-[#26547C] mb-1">
                                    {sz}
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    value={cfg.sizes[sz] ?? 0}
                                    onChange={(e) => {
                                      const val = Math.max(0, Number(e.target.value));
                                      setApparelConfigs((prev) => ({
                                        ...prev,
                                        [art]: {
                                          ...prev[art],
                                          sizes: {
                                            ...prev[art].sizes,
                                            [sz]: val,
                                          },
                                        },
                                      }));
                                    }}
                                    className="w-full text-center bg-white rounded-xl py-1.5 text-sm font-semibold tabular-nums"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Maillot */}
              {currentService.slug === 'maillot' && (
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Nom de l’équipe / Club
                      </label>
                      <input
                        type="text"
                        value={teamName}
                        onChange={(e) => setTeamName(e.target.value)}
                        placeholder="Ex : AS Fonctionnaires"
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Année / Saison du modèle
                      </label>
                      <input
                        type="text"
                        value={releaseYear}
                        onChange={(e) => setReleaseYear(e.target.value)}
                        placeholder="Ex : 2026"
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">
                        Qualité du maillot
                      </label>
                      <select
                        value={jerseyQuality}
                        onChange={(e) => setJerseyQuality(e.target.value)}
                        className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                      >
                        {(currentService.config?.jerseyQualities || []).map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.label} ({formatFcfa(q.price)})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700">
                        Liste des flocages (nom au dos, numéro, taille, quantité)
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setJerseyRows((prev) => [
                            ...prev,
                            {
                              id: `jr_${Date.now()}`,
                              backName: '',
                              number: '',
                              size: 'L',
                              quantity: 1,
                            },
                          ])
                        }
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#119DA4]/15 text-[#0E7F85] text-xs font-semibold min-h-[36px]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Ajouter un joueur
                      </button>
                    </div>

                    <div className="space-y-2">
                      {jerseyRows.map((row) => (
                        <div
                          key={row.id}
                          className="grid grid-cols-12 gap-2 items-center bg-[#EDF2F4]/60 p-2 rounded-2xl"
                        >
                          <input
                            type="text"
                            placeholder="Nom au dos"
                            value={row.backName}
                            onChange={(e) =>
                              setJerseyRows((prev) =>
                                prev.map((r) =>
                                  r.id === row.id ? { ...r, backName: e.target.value } : r
                                )
                              )
                            }
                            className="col-span-5 px-3 py-2 rounded-xl bg-white text-sm"
                          />
                          <input
                            type="text"
                            placeholder="N°"
                            value={row.number}
                            onChange={(e) =>
                              setJerseyRows((prev) =>
                                prev.map((r) =>
                                  r.id === row.id ? { ...r, number: e.target.value } : r
                                )
                              )
                            }
                            className="col-span-2 px-3 py-2 rounded-xl bg-white text-sm text-center"
                          />
                          <select
                            value={row.size}
                            onChange={(e) =>
                              setJerseyRows((prev) =>
                                prev.map((r) =>
                                  r.id === row.id
                                    ? { ...r, size: e.target.value as JerseyRow['size'] }
                                    : r
                                )
                              )
                            }
                            className="col-span-2 px-2 py-2 rounded-xl bg-white text-sm"
                          >
                            {['XS', 'S', 'M', 'L', 'XL', 'XXL'].map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={1}
                            value={row.quantity}
                            onChange={(e) =>
                              setJerseyRows((prev) =>
                                prev.map((r) =>
                                  r.id === row.id
                                    ? { ...r, quantity: Math.max(1, Number(e.target.value)) }
                                    : r
                                )
                              )
                            }
                            className="col-span-2 px-2 py-2 rounded-xl bg-white text-sm text-center"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              jerseyRows.length > 1 &&
                              setJerseyRows((prev) => prev.filter((r) => r.id !== row.id))
                            }
                            className="col-span-1 flex justify-center text-slate-400 hover:text-[#EF233C]"
                            aria-label="Supprimer ligne"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Étiquettes */}
              {currentService.slug === 'etiquettes' && (
                <div className="grid sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Largeur (cm)
                    </label>
                    <input
                      type="number"
                      min={1}
                      step="0.1"
                      value={width}
                      onChange={(e) => setWidth(Number(e.target.value))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Hauteur (cm)
                    </label>
                    <input
                      type="number"
                      min={1}
                      step="0.1"
                      value={height}
                      onChange={(e) => setHeight(Number(e.target.value))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Quantité d’étiquettes
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={qty}
                      onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                      className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] text-base min-h-[44px]"
                    />
                  </div>
                </div>
              )}

              {/* Free Remarks */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Remarques particulières (finition, grammage papier, délai souhaité)
                </label>
                <textarea
                  rows={2}
                  value={itemNotes}
                  onChange={(e) => setItemNotes(e.target.value)}
                  placeholder="Précisez tout détail utile pour l’atelier..."
                  className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white text-base"
                />
              </div>

              {/* Estimated Price Bar */}
              {draftItemPreview && (
                <div className="bg-[#EDF2F4] rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <span className="text-xs text-slate-600 block">
                      Estimation de cette prestation ({draftItemPreview.summaryText})
                    </span>
                    <span className="text-2xl font-bold text-[#26547C] tabular-nums">
                      {formatFcfa(draftItemPreview.subtotal)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddToCart}
                    className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full border-2 border-[#119DA4] text-[#26547C] font-semibold text-sm hover:bg-[#119DA4] hover:text-white transition-colors min-h-[44px]"
                  >
                    <Plus className="w-4 h-4" />
                    Ajouter au panier (multi-prestations)
                  </button>
                </div>
              )}
            </div>

            {/* Active Cart Summary directly below Add to Cart */}
            {cartItems.length > 0 && (
              <div className="rounded-2xl p-4 sm:p-5 bg-[#EDF2F4]/70 border border-[#119DA4]/35 space-y-3 min-w-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-bold text-[#26547C] text-sm sm:text-base min-w-0">
                    <ShoppingBag className="w-5 h-5 text-[#119DA4] shrink-0" />
                    <span className="truncate">
                      Panier de commande ({cartItems.length} prestation
                      {cartItems.length > 1 ? 's' : ''})
                    </span>
                  </div>
                  <span className="font-bold text-[#26547C] tabular-nums shrink-0">
                    {formatFcfa(subtotal)}
                  </span>
                </div>
                <div className="divide-y divide-slate-200/80">
                  {cartItems.map((it) => (
                    <div
                      key={it.itemId}
                      className="py-2.5 first:pt-1 last:pb-0 flex items-center justify-between gap-3 text-sm min-w-0"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="font-semibold text-[#26547C]">
                          {it.serviceName}
                        </span>{' '}
                        <span className="text-slate-600 break-words">— {it.summaryText}</span>
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                        <span className="font-bold tabular-nums text-[#26547C]">
                          {formatFcfa(it.subtotal)}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setCartItems((prev) => prev.filter((x) => x.itemId !== it.itemId))
                          }
                          className="p-2 text-slate-400 hover:text-[#EF233C] transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center"
                          aria-label="Supprimer la prestation"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step2Error && (
              <p className="text-sm font-medium text-[#EF233C]">{step2Error}</p>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-slate-300 text-slate-700 font-medium text-sm min-h-[44px]"
              >
                <ArrowLeft className="w-4 h-4" />
                Retour
              </button>

              <button
                type="button"
                onClick={handleContinueFromStep2}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] min-h-[48px]"
              >
                Envoyer mes fichiers
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: Uncompressed Resumable File Uploads */}
      {step === 3 && (
        <div className="bg-white rounded-3xl p-4 sm:p-8 border border-slate-200 shadow-sm space-y-6 min-w-0 overflow-hidden">
          <div className="space-y-2">
            <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
              Envoi de vos fichiers originaux
            </h1>
            <div className="p-4 rounded-2xl bg-[#119DA4]/10 border border-[#119DA4]/25 flex items-start gap-3">
              <FileCheck2 className="w-5 h-5 text-[#119DA4] shrink-0 mt-0.5" />
              <div className="text-xs sm:text-sm text-[#26547C] min-w-0">
                <strong>Vos fichiers sont envoyés sans aucune compression.</strong>{' '}
                Chaque fichier est transféré par morceaux avec reprise automatique en cas de
                coupure réseau et vérifié octet pour octet (SHA-256). Taille maximale :{' '}
                {settings.maxFileSizeMb >= 1024 ? '1 Go' : `${settings.maxFileSizeMb} Mo`} ·
                Formats : {settings.allowedExtensions.join(', ')}.
              </div>
            </div>
          </div>

          <div className="space-y-6 min-w-0">
            {cartItems.map((item) => {
              const slots = getRequiredSlotsForItem(item);
              const sizeEntries = item.apparelSizes
                ? getNonZeroApparelSizes(item.apparelSizes)
                : item.jerseyRows
                  ? getJerseySizeBreakdown(item.jerseyRows)
                  : [];
              return (
                <div
                  key={item.itemId}
                  className="rounded-3xl p-4 sm:p-5 bg-[#EDF2F4]/60 border border-slate-200 space-y-4 min-w-0 overflow-hidden"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <div className="min-w-0">
                      <h2 className="font-bold text-base text-[#26547C]">
                        {item.serviceName}
                      </h2>
                      <p className="text-xs text-slate-600 break-words">{item.summaryText}</p>
                      {sizeEntries.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {sizeEntries.map(([sz, count]) => (
                            <span
                              key={sz}
                              className="px-2.5 py-0.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold text-[#26547C] tabular-nums"
                            >
                              {sz} : {count}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
                    {slots.map((slot) => {
                      const progressKey = `${item.itemId}__${slot.slotKey}`;
                      const uploaded = uploadedFiles.find(
                        (f) => f.itemId === item.itemId && f.slotKey === slot.slotKey
                      );
                      const progress = uploadProgressMap[progressKey];

                      return (
                        <div
                          key={slot.slotKey}
                          className="bg-white rounded-2xl p-4 border border-slate-200 space-y-3 min-w-0 overflow-hidden"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-[#26547C] break-words">
                              {slot.slotLabel} {slot.required ? '*' : ''}
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5 break-words">
                              {slot.helper}
                            </div>
                          </div>

                          {!uploaded && (!progress || progress.status === 'error') && (
                            <label
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                e.preventDefault();
                                const f = e.dataTransfer.files?.[0];
                                if (f) handleSlotFileUpload(item, slot.slotKey, slot.slotLabel, f);
                              }}
                              className="flex flex-col items-center justify-center gap-2 p-5 rounded-2xl border-2 border-dashed border-[#26547C]/30 hover:border-[#119DA4] bg-[#EDF2F4]/40 cursor-pointer transition-colors text-center min-w-0"
                            >
                              <UploadCloud className="w-6 h-6 text-[#119DA4]" />
                              <span className="text-xs sm:text-sm font-semibold text-[#26547C]">
                                Glisser-déposer ou choisir le fichier
                              </span>
                              <input
                                type="file"
                                accept={settings.allowedExtensions.join(',')}
                                className="sr-only"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) handleSlotFileUpload(item, slot.slotKey, slot.slotLabel, f);
                                }}
                              />
                            </label>
                          )}

                          {progress &&
                            progress.status !== 'completed' &&
                            progress.status !== 'error' && (
                              <div className="space-y-2 bg-[#EDF2F4] p-3 rounded-xl min-w-0 overflow-hidden">
                                <div className="flex items-center justify-between gap-2 text-xs font-semibold text-[#26547C] min-w-0">
                                  <span className="truncate min-w-0 flex-1">
                                    {progress.fileName}
                                  </span>
                                  <span className="tabular-nums shrink-0">{progress.percent}%</span>
                                </div>
                                <div className="h-2 rounded-full bg-white overflow-hidden">
                                  <div
                                    className="h-full bg-[#119DA4] transition-all"
                                    style={{ width: `${progress.percent}%` }}
                                  />
                                </div>
                                <div className="flex items-center justify-between gap-2 text-xs text-slate-600 min-w-0">
                                  <span className="tabular-nums truncate min-w-0">
                                    {formatBytes(progress.uploadedBytes)} /{' '}
                                    {formatBytes(progress.totalBytes)}
                                    {progress.speedBytesPerSec > 0
                                      ? ` · ${(
                                          progress.speedBytesPerSec /
                                          (1024 * 1024)
                                        ).toFixed(1)} Mo/s`
                                      : ''}
                                  </span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {progress.status === 'paused' ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          controllersRef.current[progressKey]?.resume()
                                        }
                                        className="p-1.5 rounded-full bg-white text-[#119DA4]"
                                        aria-label="Reprendre"
                                      >
                                        <Play className="w-3.5 h-3.5" />
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          controllersRef.current[progressKey]?.pause()
                                        }
                                        className="p-1.5 rounded-full bg-white text-[#26547C]"
                                        aria-label="Mettre en pause"
                                      >
                                        <Pause className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}

                          {uploaded && (
                            <div className="space-y-2.5 bg-[#2E9E6B]/10 border border-[#2E9E6B]/25 rounded-2xl p-3 min-w-0 overflow-hidden">
                              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 min-w-0">
                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                  <CheckCircle2 className="w-4 h-4 text-[#2E9E6B] shrink-0 mt-0.5" />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-xs font-bold text-[#26547C] break-words [overflow-wrap:anywhere] leading-snug">
                                      {uploaded.originalName}
                                    </div>
                                    <div className="text-xs text-slate-600 tabular-nums mt-0.5 break-words">
                                      {formatBytes(uploaded.sizeBytes)}
                                      {uploaded.widthPx && uploaded.heightPx
                                        ? ` · ${uploaded.widthPx}×${uploaded.heightPx} px`
                                        : ''}
                                      {uploaded.estimatedDpi
                                        ? ` · ~${uploaded.estimatedDpi} DPI`
                                        : ''}
                                    </div>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeUploadedSlotFile(item.itemId, slot.slotKey)
                                  }
                                  className="self-start sm:self-auto px-3 py-1 rounded-full bg-white border border-[#EF233C]/30 text-xs font-semibold text-[#EF233C] hover:bg-[#EF233C] hover:text-white transition-colors shrink-0"
                                >
                                  Remplacer
                                </button>
                              </div>

                              {uploaded.lowQualityWarning && (
                                <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 p-2 rounded-xl border border-amber-200">
                                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
                                  <span className="min-w-0 break-words">
                                    Résolution estimée faible ({uploaded.estimatedDpi} DPI) pour
                                    ce format. Vous pouvez continuer ou remplacer par un fichier
                                    plus net.
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {step3Error && (
            <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
              {step3Error}
            </p>
          )}

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-slate-300 text-slate-700 font-medium text-sm min-h-[44px]"
            >
              <ArrowLeft className="w-4 h-4" />
              Retour aux prestations
            </button>

            <button
              type="button"
              disabled={!allRequiredSlotsMet}
              onClick={() => setStep(4)}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] min-h-[48px] disabled:opacity-50"
            >
              Vérifier le récapitulatif
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: Summary & Validation */}
      {step === 4 && (
        <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-6">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
              Récapitulatif et validation
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Relisez chaque ligne avant de générer votre devis officiel et votre numéro de
              suivi.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            <div className="bg-[#EDF2F4] rounded-2xl p-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#26547C]">Coordonnées</span>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-xs font-semibold text-[#119DA4] hover:underline"
                >
                  Modifier
                </button>
              </div>
              <p className="text-sm text-slate-800 font-semibold">{customerName}</p>
              <p className="text-sm text-slate-700 tabular-nums">
                {customerPhone} {isWhatsapp ? '· WhatsApp' : ''}
              </p>
              <p className="text-sm text-slate-700">
                {wantsDelivery
                  ? `Livraison (${selectedZone?.name}) : ${deliveryAddress}`
                  : 'Retrait à l’agence FBC Print'}
              </p>
            </div>

            <div className="bg-[#EDF2F4] rounded-2xl p-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#26547C]">Montant du devis</span>
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="text-xs font-semibold text-[#119DA4] hover:underline"
                >
                  Modifier
                </button>
              </div>
              <div className="text-sm flex justify-between">
                <span>Prestations ({cartItems.length})</span>
                <span className="font-semibold tabular-nums">{formatFcfa(subtotal)}</span>
              </div>
              {deliveryFee > 0 && (
                <div className="text-sm flex justify-between">
                  <span>Livraison</span>
                  <span className="font-semibold tabular-nums">
                    {formatFcfa(deliveryFee)}
                  </span>
                </div>
              )}
              {urgentFee > 0 && (
                <div className="text-sm flex justify-between text-[#EF233C]">
                  <span>Majoration urgence</span>
                  <span className="font-semibold tabular-nums">
                    {formatFcfa(urgentFee)}
                  </span>
                </div>
              )}
              <div className="pt-2 border-t border-slate-300 flex justify-between text-lg font-bold text-[#26547C]">
                <span>Total estimé</span>
                <span className="tabular-nums">{formatFcfa(totalAmount)}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-base text-[#26547C]">
                Détail des prestations &amp; fichiers ({uploadedFiles.length} fichier
                {uploadedFiles.length > 1 ? 's' : ''})
              </h2>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="text-xs font-semibold text-[#119DA4] hover:underline"
              >
                Modifier les fichiers
              </button>
            </div>
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-2xl p-4">
              {cartItems.map((it) => {
                const sizeEntries = it.apparelSizes
                  ? getNonZeroApparelSizes(it.apparelSizes)
                  : it.jerseyRows
                    ? getJerseySizeBreakdown(it.jerseyRows)
                    : [];
                return (
                  <div key={it.itemId} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex justify-between text-sm font-semibold text-[#26547C]">
                      <span>{it.serviceName}</span>
                      <span className="tabular-nums">{formatFcfa(it.subtotal)}</span>
                    </div>
                    <div className="text-xs text-slate-600">{it.summaryText}</div>
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
                );
              })}
            </div>
          </div>

          <div className="bg-[#EDF2F4]/70 rounded-2xl p-4 space-y-3">
            <div className="text-xs text-slate-600 whitespace-pre-line leading-relaxed max-h-28 overflow-y-auto">
              {settings.termsText}
            </div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
                className="w-5 h-5 mt-0.5 accent-[#119DA4] rounded"
              />
              <span className="text-sm font-semibold text-[#26547C]">
                J’accepte les conditions de commande et je confirme que mes fichiers sont
                conformes à l’impression demandée.
              </span>
            </label>
          </div>

          {submitError && (
            <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
              {submitError}
            </p>
          )}

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setStep(3)}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-slate-300 text-slate-700 font-medium text-sm min-h-[44px]"
            >
              <ArrowLeft className="w-4 h-4" />
              Retour aux fichiers
            </button>

            <button
              type="button"
              disabled={submittingOrder}
              onClick={handleFinalSubmit}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-9 py-4 rounded-full bg-[#EF233C] text-white font-bold text-base hover:bg-[#d81b32] shadow-sm min-h-[48px] disabled:opacity-60"
            >
              {submittingOrder && <Loader2 className="w-5 h-5 animate-spin" />}
              Passer ma commande
            </button>
          </div>
        </div>
      )}

      {/* Floating Bottom Progress & Real-Time Estimate Bar (Steps 1-4) */}
      {step <= 4 && (
        <div className="sticky bottom-3 z-30">
          <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 shadow-lg shadow-slate-900/10 rounded-2xl overflow-hidden">
            {/* Step Progress Track */}
            <div className="h-1 w-full bg-slate-200/80 overflow-hidden">
              <div
                className="h-full w-full bg-[#119DA4] origin-left transition-transform duration-300 ease-out"
                style={{ transform: `scaleX(${stepProgressPercent / 100})` }}
              />
            </div>

            {/* Expandable Breakdown Drawer */}
            {showStickyBreakdown && (
              <div className="px-4 sm:px-5 py-3 bg-[#EDF2F4]/70 border-b border-slate-200/80 space-y-1.5 text-xs sm:text-sm">
                <div className="flex items-center justify-between gap-2 text-slate-700">
                  <span>
                    Prestations{' '}
                    {liveItemsCount > 0
                      ? `(${liveItemsCount} ${liveItemsCount > 1 ? 'éléments' : 'élément'})`
                      : '(à configurer à l’étape 2)'}
                  </span>
                  <span className="font-semibold text-[#26547C] tabular-nums">
                    {formatFcfa(liveItemsSubtotal)}
                  </span>
                </div>

                {step === 2 &&
                  cartItems.length > 0 &&
                  draftItemPreview &&
                  draftItemPreview.subtotal > 0 && (
                    <div className="flex items-center justify-between gap-2 text-slate-500 text-xs">
                      <span className="truncate">
                        Prestation en cours (non ajoutée au panier)
                      </span>
                      <span className="tabular-nums shrink-0">
                        + {formatFcfa(draftItemPreview.subtotal)}
                      </span>
                    </div>
                  )}

                <div className="flex items-center justify-between gap-2 text-slate-700">
                  <span className="truncate">
                    {wantsDelivery && selectedZone
                      ? `Livraison (${selectedZone.name})`
                      : 'Retrait à l’agence FBC Print'}
                  </span>
                  <span className="font-semibold text-[#26547C] tabular-nums shrink-0">
                    {deliveryFee > 0 ? formatFcfa(deliveryFee) : 'Gratuit'}
                  </span>
                </div>

                {urgent && (
                  <div className="flex items-center justify-between gap-2 text-[#EF233C]">
                    <span>
                      Traitement urgent (+{settings.urgentSurchargePercent || 25}%)
                    </span>
                    <span className="font-semibold tabular-nums shrink-0">
                      {liveUrgentFee > 0 ? formatFcfa(liveUrgentFee) : 'Selon prestations'}
                    </span>
                  </div>
                )}

                {liveEstimatedTotal > 0 && (
                  <div className="pt-1.5 border-t border-slate-300/70 flex items-center justify-between gap-2 text-xs text-slate-600">
                    <span>Acompte indicatif ({settings.depositPercent || 70}%)</span>
                    <span className="font-semibold text-[#119DA4] tabular-nums">
                      {formatFcfa(liveDepositAmount)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Compact Main Bar */}
            <div className="px-4 sm:px-5 py-2.5 sm:py-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="font-bold text-[#26547C] whitespace-nowrap">
                    Étape {step}/4 · {stepShortTitles[step]}
                  </span>
                  <span className="hidden sm:inline text-slate-300" aria-hidden="true">
                    ·
                  </span>
                  <span className="hidden sm:inline truncate">
                    {liveItemsCount > 0
                      ? `${liveItemsCount} prestation${liveItemsCount > 1 ? 's' : ''}`
                      : 'Configuration en attente'}
                    {wantsDelivery && deliveryFee > 0
                      ? ` · Livraison +${formatFcfa(deliveryFee)}`
                      : ''}
                    {urgent ? ` · Urgent +${settings.urgentSurchargePercent}%` : ''}
                  </span>
                </div>

                <div className="sm:hidden text-[11px] text-slate-500 truncate mt-0.5">
                  {liveItemsCount > 0
                    ? `${liveItemsCount} prestation${liveItemsCount > 1 ? 's' : ''}`
                    : 'Tarif calculé à l’étape 2'}
                  {wantsDelivery && deliveryFee > 0 ? ' · Livraison' : ''}
                  {urgent ? ' · Urgent' : ''}
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                <div className="text-right">
                  <span className="block text-[10px] sm:text-xs text-slate-500 leading-none">
                    Total estimé
                  </span>
                  <span className="text-base sm:text-xl font-bold text-[#26547C] tabular-nums leading-tight">
                    {formatFcfa(liveEstimatedTotal)}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowStickyBreakdown((v) => !v)}
                  aria-expanded={showStickyBreakdown}
                  aria-label={
                    showStickyBreakdown
                      ? 'Masquer le détail de l’estimation'
                      : 'Afficher le détail de l’estimation'
                  }
                  className="inline-flex items-center justify-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#EDF2F4] hover:bg-slate-200/80 text-[#26547C] text-xs font-semibold transition-colors min-h-[40px]"
                >
                  <span className="hidden sm:inline">Détail</span>
                  {showStickyBreakdown ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronUp className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 5: Confirmation, Quote PDF & Payment */}
      {step === 5 && createdOrder && (
        <div className="space-y-6">
          <div className="fbc-pattern-bg rounded-3xl p-6 sm:p-10 border border-slate-200 shadow-sm text-center space-y-5">
            <img
              src="/assets/aistudio/logo_vertical_1804a5ee.svg"
              alt="FBC Print"
              className="h-24 mx-auto object-contain"
            />
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#2E9E6B]/15 text-[#237A52] text-sm font-bold">
              <CheckCircle2 className="w-4 h-4" />
              Commande enregistrée avec succès
            </div>

            <h1 className="font-display text-2xl sm:text-3xl text-[#26547C]">
              {createdOrder.orderNumber}
            </h1>
            <p className="text-sm sm:text-base text-slate-700 max-w-xl mx-auto">
              Conservez votre code de suivi{' '}
              <strong className="font-mono text-[#26547C]">
                {createdOrder.trackingCode}
              </strong>{' '}
              ou votre lien privé pour suivre votre impression et télécharger votre reçu.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => generateQuotePdf(createdOrder, settings)}
                className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-[#26547C] text-white font-semibold text-base hover:bg-[#1e4466] min-h-[48px]"
              >
                <Download className="w-5 h-5" />
                Télécharger le devis
              </button>

              <button
                type="button"
                onClick={() => setShowPaymentBox(true)}
                className="inline-flex items-center gap-2 px-7 py-3.5 rounded-full bg-[#EF233C] text-white font-semibold text-base hover:bg-[#d81b32] min-h-[48px]"
              >
                <Wallet className="w-5 h-5" />
                Payer maintenant
              </button>

              <button
                type="button"
                onClick={() => onOrderCreatedAndTrack(createdOrder)}
                className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full border-2 border-[#119DA4] text-[#26547C] font-semibold text-base hover:bg-[#119DA4]/10 min-h-[48px]"
              >
                Suivre ma commande
              </button>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => {
                  const link = `${window.location.origin}/client/?code=${encodeURIComponent(
                    createdOrder.trackingCode
                  )}`;
                  navigator.clipboard.writeText(link);
                  setCopiedTracking(true);
                  setTimeout(() => setCopiedTracking(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#26547C] hover:underline"
              >
                {copiedTracking ? (
                  <Check className="w-3.5 h-3.5 text-[#2E9E6B]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {copiedTracking
                  ? 'Lien de suivi copié !'
                  : 'Copier le lien de suivi'}
              </button>
            </div>
          </div>

          {showPaymentBox && (
            <PaymentDeclarationPanel
              order={createdOrder}
              paymentMethods={paymentMethods}
              settings={settings}
              onOrderUpdated={(updated) => {
                setCreatedOrder(updated);
                onOrderUpdated?.(updated);
              }}
              onSuccess={() => onOrderCreatedAndTrack(createdOrder)}
            />
          )}
        </div>
      )}
    </div>
  );
};
