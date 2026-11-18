import type {
  ApparelDisposition,
  ApparelPrintTech,
  ApparelType,
  JerseyRow,
  OrderItem,
  PrintService,
  ServiceSlug,
  UploadedFileMeta,
} from '../types/fbc';

export function formatFcfa(amount: number): string {
  const rounded = Math.round(amount);
  const formatted = rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${formatted} FCFA`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 o';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

/**
 * Validates and normalizes Burkina Faso (+226) phone numbers (8 local digits).
 */
export function normalizeBurkinaPhone(raw: string): {
  valid: boolean;
  normalized: string;
  compact: string;
  error?: string;
} {
  const digits = raw.replace(/\D/g, '');
  let local = digits;
  if (digits.startsWith('226') && digits.length === 11) {
    local = digits.slice(3);
  } else if (digits.startsWith('00226') && digits.length === 13) {
    local = digits.slice(5);
  }

  if (local.length !== 8) {
    return {
      valid: false,
      normalized: raw.trim(),
      compact: digits,
      error: 'Entrez un numéro burkinabè valide à 8 chiffres (ex : +226 74 67 77 08).',
    };
  }

  const formatted = `+226 ${local.slice(0, 2)} ${local.slice(2, 4)} ${local.slice(4, 6)} ${local.slice(6, 8)}`;
  return {
    valid: true,
    normalized: formatted,
    compact: `226${local}`,
  };
}

export interface RequiredFileSlot {
  slotKey: string;
  slotLabel: string;
  required: boolean;
  helper: string;
}

export const APPAREL_DISPOSITION_LABELS: Record<ApparelDisposition, string> = {
  poitrine_gauche: 'Poitrine gauche uniquement',
  poitrine_droite: 'Poitrine droite uniquement',
  deux_poitrines: 'Les deux poitrines (gauche + droite)',
  poitrine_dos: 'Poitrine + Dos',
  deux_poitrines_dos: 'Les deux poitrines + Dos',
};

export const APPAREL_TYPE_LABELS: Record<ApparelType, string> = {
  polo: 'Polo',
  tshirt: 'T-shirt',
  casquette: 'Casquette',
};

const SIZE_ORDER = ['Unique', 'Enfant', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];

export function isApparelSlug(slug: ServiceSlug): boolean {
  return slug === 'polo' || slug === 'tshirt' || slug === 'casquette' || slug === 'habits';
}

export function getApparelTypeFromSlug(
  slug: ServiceSlug,
  fallback?: ApparelType
): ApparelType {
  if (slug === 'polo' || slug === 'tshirt' || slug === 'casquette') {
    return slug;
  }
  return fallback || 'polo';
}

export function getNonZeroApparelSizes(
  sizes?: Record<string, number>
): Array<[string, number]> {
  if (!sizes) return [];
  return Object.entries(sizes)
    .filter(([, count]) => Number(count) > 0)
    .sort(([a], [b]) => {
      const ia = SIZE_ORDER.indexOf(a);
      const ib = SIZE_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map(([size, count]) => [size, Math.round(Number(count))]);
}

export function formatApparelSizesText(sizes?: Record<string, number>): string {
  const entries = getNonZeroApparelSizes(sizes);
  if (entries.length === 0) return '';
  return entries.map(([size, count]) => `${size}×${count}`).join(', ');
}

export function getJerseySizeBreakdown(rows?: JerseyRow[]): Array<[string, number]> {
  if (!rows || rows.length === 0) return [];
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const qty = Math.max(1, Number(row.quantity) || 1);
    totals[row.size] = (totals[row.size] || 0) + qty;
  }
  return getNonZeroApparelSizes(totals);
}

export function getRequiredSlotsForItem(item: OrderItem): RequiredFileSlot[] {
  if (item.serviceSlug === 'carte_visite') {
    const slots: RequiredFileSlot[] = [
      {
        slotKey: 'recto',
        slotLabel: 'Fichier Recto',
        required: true,
        helper: 'Face avant de la carte de visite (résolution recommandée 300 DPI).',
      },
    ];
    if (item.sides === 'recto_verso') {
      slots.push({
        slotKey: 'verso',
        slotLabel: 'Fichier Verso',
        required: true,
        helper: 'Face arrière de la carte de visite.',
      });
    }
    return slots;
  }

  if (isApparelSlug(item.serviceSlug)) {
    const article = getApparelTypeFromSlug(item.serviceSlug, item.apparelType);
    const articleLabel = APPAREL_TYPE_LABELS[article].toLowerCase();

    const slots: RequiredFileSlot[] = [
      {
        slotKey: 'modele_habit',
        slotLabel: `Modèle ${article === 'casquette' ? 'de la casquette' : `du ${articleLabel}`} (référence)`,
        required: true,
        helper: `Photo ou fichier de référence pour ${article === 'casquette' ? 'la casquette choisie' : `le ${articleLabel} choisi`}.`,
      },
      {
        slotKey: 'maquette_dispositions',
        slotLabel: `Maquette globale (${APPAREL_TYPE_LABELS[article]})`,
        required: true,
        helper: `Visuel d’ensemble indiquant le placement souhaité sur ${article === 'casquette' ? 'la casquette' : `le ${articleLabel}`}.`,
      },
    ];

    if (article === 'casquette') {
      slots.push({
        slotKey: 'face_avant',
        slotLabel: 'Fichier Face avant (Casquette)',
        required: true,
        helper: 'Logo ou visuel haute définition à imprimer sur la face avant de la casquette.',
      });
      return slots;
    }

    const disp = item.apparelDisposition || 'poitrine_gauche';
    if (disp === 'poitrine_gauche') {
      slots.push({
        slotKey: 'poitrine_gauche',
        slotLabel: 'Fichier Poitrine gauche',
        required: true,
        helper: 'Logo ou visuel séparé à imprimer sur la poitrine gauche.',
      });
    } else if (disp === 'poitrine_droite') {
      slots.push({
        slotKey: 'poitrine_droite',
        slotLabel: 'Fichier Poitrine droite',
        required: true,
        helper: 'Logo ou visuel séparé à imprimer sur la poitrine droite.',
      });
    } else if (disp === 'deux_poitrines') {
      slots.push(
        {
          slotKey: 'poitrine_gauche',
          slotLabel: 'Fichier Poitrine gauche',
          required: true,
          helper: 'Visuel haute définition pour la poitrine gauche.',
        },
        {
          slotKey: 'poitrine_droite',
          slotLabel: 'Fichier Poitrine droite',
          required: true,
          helper: 'Visuel haute définition pour la poitrine droite.',
        }
      );
    } else if (disp === 'poitrine_dos') {
      slots.push(
        {
          slotKey: 'poitrine_gauche',
          slotLabel: 'Fichier Poitrine',
          required: true,
          helper: 'Visuel haute définition pour l’emplacement poitrine.',
        },
        {
          slotKey: 'dos',
          slotLabel: 'Fichier Dos',
          required: true,
          helper: 'Grand visuel haute définition à imprimer au dos.',
        }
      );
    } else if (disp === 'deux_poitrines_dos') {
      slots.push(
        {
          slotKey: 'poitrine_gauche',
          slotLabel: 'Fichier Poitrine gauche',
          required: true,
          helper: 'Visuel pour la poitrine gauche.',
        },
        {
          slotKey: 'poitrine_droite',
          slotLabel: 'Fichier Poitrine droite',
          required: true,
          helper: 'Visuel pour la poitrine droite.',
        },
        {
          slotKey: 'dos',
          slotLabel: 'Fichier Dos',
          required: true,
          helper: 'Grand visuel haute définition pour le dos.',
        }
      );
    }
    return slots;
  }

  return [
    {
      slotKey: 'principal',
      slotLabel: 'Fichier d’impression principal',
      required: true,
      helper: 'Envoyé octet par octet sans aucune compression.',
    },
  ];
}

export function getPlacementCount(disposition?: ApparelDisposition): number {
  switch (disposition) {
    case 'deux_poitrines':
    case 'poitrine_dos':
      return 2;
    case 'deux_poitrines_dos':
      return 3;
    default:
      return 1;
  }
}

export function calculateItemPricing(
  service: PrintService,
  draft: Partial<OrderItem>
): { unitPrice: number; subtotal: number; summaryText: string } {
  const qty = Math.max(1, Number(draft.quantity) || 1);
  const cfg = service.config || {};

  switch (service.slug) {
    case 'grand_format':
    case 'portrait': {
      const unit = draft.unit || 'cm';
      const w = Math.max(1, Number(draft.width) || 100);
      const h = Math.max(1, Number(draft.height) || 100);
      const wMeters = unit === 'm' ? w : w / 100;
      const hMeters = unit === 'm' ? h : h / 100;
      const areaSqm = Math.max(0.25, wMeters * hMeters);
      const unitPrice = Math.round(areaSqm * service.basePrice);
      const subtotal = unitPrice * qty;
      return {
        unitPrice,
        subtotal,
        summaryText: `${w} × ${h} ${unit} (${areaSqm.toFixed(2)} m²) · Qté ${qty}`,
      };
    }

    case 'format_standard': {
      const fmtName = draft.standardFormat || 'A4';
      const found = cfg.formats?.find((f) => f.name === fmtName);
      const unitPrice = found ? found.price : service.basePrice;
      const subtotal = unitPrice * qty;
      return {
        unitPrice,
        subtotal,
        summaryText: `Format ${fmtName} · Qté ${qty}`,
      };
    }

    case 'kakemono': {
      const presetLabel = draft.kakemonoPreset;
      const foundPreset = cfg.kakemonoSizes?.find((k) => k.label === presetLabel);
      let unitPrice = foundPreset ? foundPreset.price : service.basePrice;
      if (!foundPreset && draft.width && draft.height) {
        const areaSqm = (Number(draft.width) / 100) * (Number(draft.height) / 100);
        unitPrice = Math.round(Math.max(service.basePrice, areaSqm * 22000));
      }
      if (cfg.quantityTiers && cfg.quantityTiers.length > 0 && !foundPreset) {
        const sorted = [...cfg.quantityTiers].sort((a, b) => b.minQty - a.minQty);
        const tier = sorted.find((t) => qty >= t.minQty);
        if (tier) unitPrice = tier.unitPrice;
      }
      const subtotal = unitPrice * qty;
      const dimText = foundPreset
        ? foundPreset.label
        : `${draft.width || 80} × ${draft.height || 200} cm`;
      return {
        unitPrice,
        subtotal,
        summaryText: `${dimText} · Qté ${qty}`,
      };
    }

    case 'carte_visite': {
      const tiers = cfg.quantityTiers || [
        { minQty: 100, unitPrice: 100 },
        { minQty: 250, unitPrice: 80 },
        { minQty: 500, unitPrice: 65 },
        { minQty: 1000, unitPrice: 50 },
      ];
      const sorted = [...tiers].sort((a, b) => b.minQty - a.minQty);
      const tier = sorted.find((t) => qty >= t.minQty) || tiers[0];
      const sideMult = draft.sides === 'recto_verso' ? cfg.rectoVersoMultiplier || 1.35 : 1;
      const unitPrice = Math.round(tier.unitPrice * sideMult);
      const subtotal = unitPrice * qty;
      const sideLabel = draft.sides === 'recto_verso' ? 'Recto-verso' : 'Recto seul';
      return {
        unitPrice,
        subtotal,
        summaryText: `${sideLabel} · ${qty} cartes`,
      };
    }

    case 'catalogue': {
      const pages = Math.max(4, Number(draft.pageCount) || 8);
      const perPage = cfg.pricePerPage ?? 250;
      const binding = cfg.bindingFeePerCopy ?? 500;
      const sideMult = draft.sides === 'recto_verso' ? 1 : 1.15;
      const unitPrice = Math.round(pages * perPage * sideMult + binding);
      const subtotal = unitPrice * qty;
      const sideLabel = draft.sides === 'recto_verso' ? 'Recto-verso' : 'Recto seul';
      const dim = draft.width && draft.height ? ` (${draft.width}×${draft.height} cm)` : '';
      return {
        unitPrice,
        subtotal,
        summaryText: `${pages} pages · ${sideLabel}${dim} · ${qty} ex.`,
      };
    }

    case 'polo':
    case 'tshirt':
    case 'casquette':
    case 'habits': {
      const article: ApparelType = getApparelTypeFromSlug(service.slug, draft.apparelType);
      const tech: ApparelPrintTech = draft.apparelTech || 'dtf';
      const disp: ApparelDisposition = draft.apparelDisposition || 'poitrine_gauche';
      const articleBase =
        service.slug === 'habits'
          ? cfg.apparelArticleBasePrices?.[article] ?? service.basePrice
          : service.basePrice;
      const techAdd = cfg.apparelTechPrices?.[tech] ?? 1000;
      const placementCount = article === 'casquette' ? 1 : getPlacementCount(disp);
      const placementAdd = (cfg.apparelPlacementPrice ?? 1000) * placementCount;
      const unitPrice = articleBase + techAdd + placementAdd;
      const sizesTotal = draft.apparelSizes
        ? Object.values(draft.apparelSizes).reduce((acc, n) => acc + (Number(n) || 0), 0)
        : 0;
      const effectiveQty = sizesTotal > 0 ? sizesTotal : qty;
      const subtotal = unitPrice * effectiveQty;
      const articleLabel = APPAREL_TYPE_LABELS[article];
      const dispLabel =
        article === 'casquette' ? 'Face avant' : APPAREL_DISPOSITION_LABELS[disp];
      const sizeStr = formatApparelSizesText(draft.apparelSizes);
      const sizeSegment = sizeStr
        ? `Tailles : ${sizeStr} (Total : ${effectiveQty})`
        : `Qté ${effectiveQty}`;
      return {
        unitPrice,
        subtotal,
        summaryText: `${articleLabel} · ${tech.toUpperCase()} · ${dispLabel} · ${sizeSegment}`,
      };
    }

    case 'maillot': {
      const qualities = cfg.jerseyQualities || [
        { id: 'standard', label: 'Standard Club', price: 6500 },
        { id: 'pro', label: 'Pro Respirant', price: 9000 },
        { id: 'authentique', label: 'Authentique Match', price: 12000 },
      ];
      const qFound =
        qualities.find((q) => q.id === draft.jerseyQuality || q.label === draft.jerseyQuality) ||
        qualities[0];
      const unitPrice = qFound.price;
      const rowsQty =
        draft.jerseyRows && draft.jerseyRows.length > 0
          ? draft.jerseyRows.reduce((sum, r) => sum + Math.max(1, Number(r.quantity) || 1), 0)
          : qty;
      const subtotal = unitPrice * rowsQty;
      const team = draft.teamName ? `${draft.teamName} ` : '';
      const year = draft.releaseYear ? `(${draft.releaseYear}) ` : '';
      const sizeBreakdown = getJerseySizeBreakdown(draft.jerseyRows);
      const sizesText =
        sizeBreakdown.length > 0
          ? ` · Tailles : ${sizeBreakdown.map(([s, c]) => `${s}×${c}`).join(', ')}`
          : '';
      return {
        unitPrice,
        subtotal,
        summaryText: `Maillot ${team}${year}· Qualité ${qFound.label} · ${rowsQty} pièce(s)${sizesText}`,
      };
    }

    case 'etiquettes': {
      const tiers = cfg.quantityTiers || [
        { minQty: 50, unitPrice: 300 },
        { minQty: 100, unitPrice: 220 },
        { minQty: 250, unitPrice: 160 },
        { minQty: 500, unitPrice: 120 },
        { minQty: 1000, unitPrice: 90 },
      ];
      const sorted = [...tiers].sort((a, b) => b.minQty - a.minQty);
      const tier = sorted.find((t) => qty >= t.minQty) || tiers[0];
      const unitPrice = tier.unitPrice;
      const subtotal = unitPrice * qty;
      const dim = draft.width && draft.height ? `${draft.width} × ${draft.height} cm · ` : '';
      return {
        unitPrice,
        subtotal,
        summaryText: `${dim}Qté ${qty} étiquettes`,
      };
    }

    default: {
      return {
        unitPrice: service.basePrice,
        subtotal: service.basePrice * qty,
        summaryText: `Qté ${qty}`,
      };
    }
  }
}

/**
 * Estimates DPI from pixel dimensions and requested print dimensions in cm.
 */
export function estimatePrintDpi(
  file: Pick<UploadedFileMeta, 'widthPx' | 'heightPx'>,
  item?: OrderItem
): { estimatedDpi?: number; lowQualityWarning: boolean } {
  if (!file.widthPx || !file.heightPx || !item) {
    return { lowQualityWarning: false };
  }

  let targetWidthCm = 0;
  let targetHeightCm = 0;

  if (item.width && item.height) {
    const mult = item.unit === 'm' ? 100 : 1;
    targetWidthCm = item.width * mult;
    targetHeightCm = item.height * mult;
  } else if (item.serviceSlug === 'format_standard') {
    const map: Record<string, [number, number]> = {
      A0: [84.1, 118.9],
      A1: [59.4, 84.1],
      A2: [42.0, 59.4],
      A3: [29.7, 42.0],
      A4: [21.0, 29.7],
      A5: [14.8, 21.0],
      A6: [10.5, 14.8],
    };
    const found = map[item.standardFormat || 'A4'];
    if (found) {
      targetWidthCm = found[0];
      targetHeightCm = found[1];
    }
  } else if (item.serviceSlug === 'carte_visite') {
    targetWidthCm = 8.5;
    targetHeightCm = 5.5;
  }

  if (targetWidthCm <= 0 || targetHeightCm <= 0) {
    return { lowQualityWarning: false };
  }

  const widthInches = targetWidthCm / 2.54;
  const heightInches = targetHeightCm / 2.54;
  const dpiX = file.widthPx / widthInches;
  const dpiY = file.heightPx / heightInches;
  const estimatedDpi = Math.round(Math.min(dpiX, dpiY));

  const minRecommended = item.serviceSlug === 'grand_format' || item.serviceSlug === 'kakemono' ? 72 : 150;
  return {
    estimatedDpi,
    lowQualityWarning: estimatedDpi < minRecommended,
  };
}
