export type ServiceSlug =
  | 'grand_format'
  | 'format_standard'
  | 'portrait'
  | 'kakemono'
  | 'carte_visite'
  | 'catalogue'
  | 'polo'
  | 'tshirt'
  | 'casquette'
  | 'habits'
  | 'maillot'
  | 'etiquettes';

export type PricingMode =
  | 'per_sqm'
  | 'per_format'
  | 'per_unit_tier'
  | 'per_apparel'
  | 'per_jersey'
  | 'per_page_copy';

export type ApparelType = 'polo' | 'tshirt' | 'casquette';
export type ApparelPrintTech = 'sublimation' | 'dtf';
export type ApparelDisposition =
  | 'poitrine_gauche'
  | 'poitrine_droite'
  | 'deux_poitrines'
  | 'poitrine_dos'
  | 'deux_poitrines_dos';

export type OrderStatus =
  | 'recue'
  | 'en_verification'
  | 'fichier_a_corriger'
  | 'en_attente_paiement'
  | 'payee'
  | 'en_production'
  | 'prete'
  | 'livree'
  | 'annulee';

export type PaymentStatus =
  | 'non_paye'
  | 'en_attente_validation'
  | 'partiellement_paye'
  | 'paye'
  | 'rejete';

export interface PriceTier {
  minQty: number;
  unitPrice: number;
}

export interface DeliveryZone {
  id: string;
  name: string;
  fee: number;
}

export interface ShopSettings {
  shopName: string;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  openingHours: string;
  isOpen: boolean;
  closedMessage: string;
  allowedExtensions: string[];
  maxFileSizeMb: number;
  quoteValidityDays: number;
  fileRetentionDays: number;
  depositPercent: number;
  urgentSurchargePercent: number;
  deliveryZones: DeliveryZone[];
  termsText: string;
  telegramBotEnabled: boolean;
  whatsappAdminNumber: string;
  updatedAt?: string;
}

export interface PrintServiceConfig {
  formats?: Array<{ name: string; widthCm: number; heightCm: number; price: number }>;
  kakemonoSizes?: Array<{ label: string; widthCm: number; heightCm: number; price: number }>;
  quantityTiers?: PriceTier[];
  rectoVersoMultiplier?: number;
  apparelTechPrices?: Record<ApparelPrintTech, number>;
  apparelArticleBasePrices?: Record<ApparelType, number>;
  apparelPlacementPrice?: number;
  jerseyQualities?: Array<{ id: string; label: string; price: number }>;
  pricePerPage?: number;
  bindingFeePerCopy?: number;
}

export interface PrintService {
  id: string;
  slug: ServiceSlug;
  name: string;
  description: string;
  imageKey: string;
  imageUrl?: string;
  pricingMode: PricingMode;
  basePrice: number;
  recommendedDpi: number;
  active: boolean;
  sortOrder: number;
  config?: PrintServiceConfig;
  updatedAt?: string;
}

export interface PaymentMethod {
  id: string;
  operatorName: string;
  phoneNumber: string;
  accountHolder: string;
  instructions: string;
  ussdCode?: string;
  active: boolean;
  sortOrder: number;
}

export interface JerseyRow {
  id: string;
  backName: string;
  number: string;
  size: 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';
  quantity: number;
}

export interface OrderItem {
  itemId: string;
  serviceId: string;
  serviceSlug: ServiceSlug;
  serviceName: string;
  quantity: number;
  width?: number;
  height?: number;
  unit?: 'cm' | 'm';
  standardFormat?: string;
  kakemonoPreset?: string;
  sides?: 'recto' | 'recto_verso';
  pageCount?: number;
  apparelTech?: ApparelPrintTech;
  apparelType?: ApparelType;
  apparelDisposition?: ApparelDisposition;
  apparelSizes?: Record<string, number>;
  teamName?: string;
  releaseYear?: string;
  jerseyQuality?: string;
  jerseyRows?: JerseyRow[];
  notes?: string;
  unitPrice: number;
  subtotal: number;
  summaryText: string;
}

export interface UploadedFileMeta {
  fileId: string;
  itemId: string;
  slotKey: string;
  slotLabel: string;
  originalName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  widthPx?: number;
  heightPx?: number;
  widthCm?: number;
  heightCm?: number;
  pageCount?: number;
  colorSpace?: string;
  estimatedDpi?: number;
  lowQualityWarning?: boolean;
  previewAvailable: boolean;
  version: number;
  replaced?: boolean;
  uploadedAt: string;
}

export interface StatusHistoryEntry {
  status: OrderStatus;
  label: string;
  actor: string;
  note?: string;
  timestamp: string;
}

export interface LatestPaymentSummary {
  paymentId: string;
  methodName: string;
  depositPhone: string;
  transactionRef?: string;
  declaredAmount: number;
  paymentType: 'acompte' | 'integral' | 'solde';
  status: 'en_attente_validation' | 'valide' | 'rejete';
  rejectionReason?: string;
  validatedAt?: string;
  createdAt: string;
}

export interface Order {
  orderId: string;
  orderNumber: string;
  trackingCode: string;
  quoteNumber: string;
  receiptNumber?: string;
  clientAccountId?: string;
  customerName: string;
  customerPhone: string;
  isWhatsapp: boolean;
  wantsDelivery: boolean;
  deliveryZoneId?: string;
  deliveryZoneName?: string;
  deliveryAddress?: string;
  deliveryFee: number;
  urgent: boolean;
  urgentFee: number;
  discountAmount: number;
  subtotal: number;
  totalAmount: number;
  depositRequiredAmount: number;
  paidAmount: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentRejectionReason?: string;
  correctionRequestMessage?: string;
  cancellationReason?: string;
  promisedDeliveryDate?: string;
  internalNotes?: string;
  acceptedTerms: boolean;
  quoteValidUntil: string;
  items: OrderItem[];
  files: UploadedFileMeta[];
  statusHistory: StatusHistoryEntry[];
  paymentIds?: string[];
  latestPayment?: LatestPaymentSummary;
  source: 'web' | 'manual_admin';
  createdAt: unknown;
  updatedAt: unknown;
  createdAtIso?: string;
}

export interface ClientAccountPublic {
  accountId: string;
  username: string;
  fullName: string;
  phone: string;
  phoneNormalized: string;
  mustChangePassword?: boolean;
  active: boolean;
  lastLoginAt?: string;
  createdAt?: string;
}

export interface AdminClientAccountSummary extends ClientAccountPublic {
  ordersCount: number;
}

export interface Payment {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  methodId: string;
  methodName: string;
  depositPhone: string;
  transactionRef?: string;
  declaredAmount: number;
  paymentType: 'acompte' | 'integral' | 'solde';
  screenshotFileId?: string;
  screenshotPreviewUrl?: string;
  status: 'en_attente_validation' | 'valide' | 'rejete';
  rejectionReason?: string;
  validatedByEmail?: string;
  validatedAt?: string;
  createdAt: unknown;
}

export interface ClientProfile {
  clientId: string;
  name: string;
  phone: string;
  isWhatsapp: boolean;
  address?: string;
  notes?: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt?: string;
  createdAt: unknown;
}

export interface AdminUser {
  uid: string;
  email: string;
  displayName?: string;
  role: 'admin' | 'operator';
  active: boolean;
  accessId?: string;
  authMethod?: 'google' | 'credentials';
  lastLoginAt?: string;
  createdAt: unknown;
}

export interface StaffCredentialPublic {
  accessId: string;
  displayName: string;
  role: 'admin' | 'operator';
  active: boolean;
  createdBy: string;
  lastLoginAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminInvite {
  email: string;
  role: 'admin' | 'operator';
  displayName?: string;
  invitedBy: string;
  createdAt: unknown;
}

export interface AuditLog {
  logId: string;
  action: string;
  targetType: string;
  targetId: string;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
  details?: string;
  createdAt: unknown;
}

export const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; bg: string; text: string; border: string }
> = {
  recue: {
    label: 'Reçue',
    bg: 'bg-[#26547C]/10',
    text: 'text-[#26547C]',
    border: 'border-[#26547C]/25',
  },
  en_verification: {
    label: 'En vérification',
    bg: 'bg-[#119DA4]/10',
    text: 'text-[#119DA4]',
    border: 'border-[#119DA4]/25',
  },
  fichier_a_corriger: {
    label: 'Fichier à corriger',
    bg: 'bg-[#EF233C]/10',
    text: 'text-[#EF233C]',
    border: 'border-[#EF233C]/30',
  },
  en_attente_paiement: {
    label: 'En attente de paiement',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
  },
  payee: {
    label: 'Payée',
    bg: 'bg-[#2E9E6B]/10',
    text: 'text-[#2E9E6B]',
    border: 'border-[#2E9E6B]/25',
  },
  en_production: {
    label: 'En production',
    bg: 'bg-[#119DA4]/15',
    text: 'text-[#0E7F85]',
    border: 'border-[#119DA4]/35',
  },
  prete: {
    label: 'Prête',
    bg: 'bg-[#26547C]',
    text: 'text-white',
    border: 'border-[#26547C]',
  },
  livree: {
    label: 'Livrée',
    bg: 'bg-[#2E9E6B]/15',
    text: 'text-[#237A52]',
    border: 'border-[#2E9E6B]/30',
  },
  annulee: {
    label: 'Annulée',
    bg: 'bg-slate-200/80',
    text: 'text-slate-600',
    border: 'border-slate-300',
  },
};

export const PAYMENT_STATUS_META: Record<
  PaymentStatus,
  { label: string; bg: string; text: string }
> = {
  non_paye: { label: 'Non payé', bg: 'bg-slate-100', text: 'text-slate-700' },
  en_attente_validation: {
    label: 'En attente de validation',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
  },
  partiellement_paye: {
    label: 'Partiellement payé',
    bg: 'bg-[#119DA4]/15',
    text: 'text-[#0E7F85]',
  },
  paye: { label: 'Payé', bg: 'bg-[#2E9E6B]/15', text: 'text-[#237A52]' },
  rejete: { label: 'Rejeté', bg: 'bg-[#EF233C]/12', text: 'text-[#EF233C]' },
};
