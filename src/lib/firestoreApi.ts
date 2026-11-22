import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_SERVICES,
  DEFAULT_SETTINGS,
} from '../data/defaults';
import type {
  AdminInvite,
  AdminUser,
  AuditLog,
  ClientProfile,
  Order,
  OrderStatus,
  Payment,
  PaymentMethod,
  PrintService,
  ShopSettings,
  UploadedFileMeta,
} from '../types/fbc';
import { ORDER_STATUS_META } from '../types/fbc';
import { db, handleFirestoreError, OperationType } from './firebase';
import { normalizeBurkinaPhone } from './pricing';

function randomToken(length = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function sanitizeForFirestore<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      // Preserve Firestore FieldValue sentinels (e.g. serverTimestamp())
      return value;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        clean[k] = sanitizeForFirestore(v);
      }
    }
    return clean as T;
  }
  return value;
}

export function buildLookupKey(trackingCode: string, phone: string): string {
  const cleanCode = trackingCode.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const { compact } = normalizeBurkinaPhone(phone);
  return `${cleanCode}_${compact}`;
}

export function expandLegacyHabitsService(services: PrintService[]): PrintService[] {
  const hasSplit = services.some(
    (s) => s.slug === 'polo' || s.slug === 'tshirt' || s.slug === 'casquette'
  );
  const legacyHabits = services.find((s) => s.slug === 'habits' || s.id === 'srv_habits');
  if (hasSplit || !legacyHabits) {
    return [...services].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  const basePrices = legacyHabits.config?.apparelArticleBasePrices;
  const sharedConfig = {
    apparelTechPrices: legacyHabits.config?.apparelTechPrices || {
      dtf: 1000,
      sublimation: 750,
    },
    apparelPlacementPrice: legacyHabits.config?.apparelPlacementPrice ?? 1000,
  };

  const splitDefaults = DEFAULT_SERVICES.filter(
    (d) => d.slug === 'polo' || d.slug === 'tshirt' || d.slug === 'casquette'
  ).map((d, idx) => ({
    ...d,
    basePrice: basePrices?.[d.slug as 'polo' | 'tshirt' | 'casquette'] ?? d.basePrice,
    active: legacyHabits.active,
    imageUrl: legacyHabits.imageUrl || d.imageUrl,
    sortOrder: legacyHabits.sortOrder + idx * 0.1,
    config: sharedConfig,
  }));

  return services
    .flatMap((s) => (s.id === legacyHabits.id ? splitDefaults : [s]))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function ensureDefaultSeedData(): Promise<void> {
  try {
    const settingsRef = doc(db, 'settings', 'shop');
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      await setDoc(
        settingsRef,
        sanitizeForFirestore({
          ...DEFAULT_SETTINGS,
          updatedAt: new Date().toISOString(),
        })
      );
    }

    const servicesSnap = await getDocs(collection(db, 'services'));
    if (servicesSnap.empty) {
      for (const srv of DEFAULT_SERVICES) {
        await setDoc(
          doc(db, 'services', srv.id),
          sanitizeForFirestore({
            ...srv,
            updatedAt: new Date().toISOString(),
          })
        );
      }
    } else {
      const existingServices = servicesSnap.docs.map((d) => d.data() as PrintService);
      const legacyHabits = existingServices.find(
        (s) => s.id === 'srv_habits' || s.slug === 'habits'
      );
      const hasSplit = existingServices.some(
        (s) => s.slug === 'polo' || s.slug === 'tshirt' || s.slug === 'casquette'
      );
      if (legacyHabits && !hasSplit) {
        const expanded = expandLegacyHabitsService([legacyHabits]);
        for (let i = 0; i < expanded.length; i++) {
          const srv = expanded[i];
          await setDoc(
            doc(db, 'services', srv.id),
            sanitizeForFirestore({
              ...srv,
              sortOrder: 7 + i,
              updatedAt: new Date().toISOString(),
            })
          );
        }
        await deleteDoc(doc(db, 'services', legacyHabits.id));
        const maillot = existingServices.find((s) => s.id === 'srv_maillot');
        if (maillot && maillot.sortOrder < 10) {
          await updateDoc(doc(db, 'services', 'srv_maillot'), { sortOrder: 10 });
        }
        const etiquettes = existingServices.find((s) => s.id === 'srv_etiquettes');
        if (etiquettes && etiquettes.sortOrder < 11) {
          await updateDoc(doc(db, 'services', 'srv_etiquettes'), { sortOrder: 11 });
        }
      }
    }

    const pmSnap = await getDocs(collection(db, 'payment_methods'));
    if (pmSnap.empty) {
      for (const pm of DEFAULT_PAYMENT_METHODS) {
        await setDoc(doc(db, 'payment_methods', pm.id), sanitizeForFirestore(pm));
      }
    }

    const counterRef = doc(db, 'counters', 'orders');
    const counterSnap = await getDoc(counterRef);
    if (!counterSnap.exists()) {
      await setDoc(counterRef, {
        lastOrderSeq: 41,
        lastQuoteSeq: 41,
        lastReceiptSeq: 12,
      });
    }
  } catch (err) {
    console.warn('Seed check skipped or partial:', err);
  }
}

export function subscribePublicCatalog(
  onSettings: (s: ShopSettings) => void,
  onServices: (list: PrintService[]) => void,
  onPaymentMethods: (list: PaymentMethod[]) => void
): Unsubscribe {
  const unsubSettings = onSnapshot(
    doc(db, 'settings', 'shop'),
    (snap) => {
      if (snap.exists()) {
        onSettings(snap.data() as ShopSettings);
      } else {
        onSettings(DEFAULT_SETTINGS);
      }
    },
    (err) => {
      console.warn('Settings read fallback:', err);
      onSettings(DEFAULT_SETTINGS);
    }
  );

  const unsubServices = onSnapshot(
    query(collection(db, 'services'), orderBy('sortOrder', 'asc')),
    (snap) => {
      if (!snap.empty) {
        onServices(
          expandLegacyHabitsService(snap.docs.map((d) => d.data() as PrintService))
        );
      } else {
        onServices(DEFAULT_SERVICES);
      }
    },
    (err) => {
      console.warn('Services read fallback:', err);
      onServices(DEFAULT_SERVICES);
    }
  );

  const unsubPm = onSnapshot(
    query(collection(db, 'payment_methods'), orderBy('sortOrder', 'asc')),
    (snap) => {
      if (!snap.empty) {
        onPaymentMethods(snap.docs.map((d) => d.data() as PaymentMethod));
      } else {
        onPaymentMethods(DEFAULT_PAYMENT_METHODS);
      }
    },
    (err) => {
      console.warn('Payment methods fallback:', err);
      onPaymentMethods(DEFAULT_PAYMENT_METHODS);
    }
  );

  return () => {
    unsubSettings();
    unsubServices();
    unsubPm();
  };
}

export async function allocateNextOrderNumbers(): Promise<{
  orderNumber: string;
  quoteNumber: string;
  trackingCode: string;
}> {
  const year = new Date().getFullYear();
  const counterRef = doc(db, 'counters', 'orders');

  try {
    const seq = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const current = snap.exists()
        ? (snap.data() as { lastOrderSeq: number; lastQuoteSeq: number; lastReceiptSeq: number })
        : { lastOrderSeq: 41, lastQuoteSeq: 41, lastReceiptSeq: 12 };

      const nextOrder = (current.lastOrderSeq || 0) + 1;
      const nextQuote = (current.lastQuoteSeq || 0) + 1;

      tx.set(counterRef, {
        lastOrderSeq: nextOrder,
        lastQuoteSeq: nextQuote,
        lastReceiptSeq: current.lastReceiptSeq || 0,
      });

      return { nextOrder, nextQuote };
    });

    return {
      orderNumber: `CMD-${year}-${String(seq.nextOrder).padStart(4, '0')}`,
      quoteNumber: `DEV-${year}-${String(seq.nextQuote).padStart(4, '0')}`,
      trackingCode: `FBC-${randomToken(6).toUpperCase()}`,
    };
  } catch {
    const fallbackNum = Math.floor(1000 + Math.random() * 8999);
    return {
      orderNumber: `CMD-${year}-${fallbackNum}`,
      quoteNumber: `DEV-${year}-${fallbackNum}`,
      trackingCode: `FBC-${randomToken(6).toUpperCase()}`,
    };
  }
}

export async function allocateNextReceiptNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const counterRef = doc(db, 'counters', 'orders');
  try {
    const nextRec = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const current = snap.exists()
        ? (snap.data() as { lastOrderSeq: number; lastQuoteSeq: number; lastReceiptSeq: number })
        : { lastOrderSeq: 41, lastQuoteSeq: 41, lastReceiptSeq: 12 };
      const nextReceipt = (current.lastReceiptSeq || 0) + 1;
      tx.set(counterRef, {
        lastOrderSeq: current.lastOrderSeq || 0,
        lastQuoteSeq: current.lastQuoteSeq || 0,
        lastReceiptSeq: nextReceipt,
      });
      return nextReceipt;
    });
    return `REC-${year}-${String(nextRec).padStart(4, '0')}`;
  } catch {
    return `REC-${year}-${Math.floor(1000 + Math.random() * 8999)}`;
  }
}

export async function createOrderInFirestore(
  payload: Omit<Order, 'orderId' | 'orderNumber' | 'quoteNumber' | 'trackingCode' | 'createdAt' | 'updatedAt'>
): Promise<Order> {
  const { orderNumber, quoteNumber, trackingCode } = await allocateNextOrderNumbers();
  const orderId = `ord_${randomToken(16)}`;
  const nowIso = new Date().toISOString();

  const orderDoc: Record<string, unknown> = {
    ...payload,
    orderId,
    orderNumber,
    quoteNumber,
    trackingCode,
    paymentIds: [],
    statusHistory: [
      {
        status: payload.status,
        label: ORDER_STATUS_META[payload.status].label,
        actor: payload.source === 'manual_admin' ? 'Atelier FBC Print' : payload.customerName,
        note: 'Commande enregistrée',
        timestamp: nowIso,
      },
    ],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const lookupKey = buildLookupKey(trackingCode, payload.customerPhone);

  const cleanOrderDoc = sanitizeForFirestore(orderDoc);

  try {
    await runTransaction(db, async (tx) => {
      tx.set(doc(db, 'orders', orderId), cleanOrderDoc);
      tx.set(doc(db, 'order_lookups', lookupKey), {
        orderId,
        orderNumber,
        createdAt: serverTimestamp(),
      });
    });

    return {
      ...(cleanOrderDoc as unknown as Order),
      createdAtIso: nowIso,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `orders/${orderId}`);
  }
}

export async function findOrderByTrackingCodeAndPhone(
  trackingCode: string,
  phone: string
): Promise<Order | null> {
  const cleanCode = trackingCode.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const phoneCheck = normalizeBurkinaPhone(phone);
  if (!cleanCode || !phoneCheck.valid) {
    return null;
  }

  const lookupKey = buildLookupKey(cleanCode, phone);
  try {
    const lookupSnap = await getDoc(doc(db, 'order_lookups', lookupKey));
    if (lookupSnap.exists()) {
      const { orderId } = lookupSnap.data() as { orderId: string };
      const orderSnap = await getDoc(doc(db, 'orders', orderId));
      if (orderSnap.exists()) {
        const order = orderSnap.data() as Order;
        const storedPhone = normalizeBurkinaPhone(order.customerPhone);
        if (
          order.trackingCode.trim().toUpperCase() === cleanCode &&
          storedPhone.compact === phoneCheck.compact
        ) {
          return order;
        }
      }
    }
  } catch (err) {
    console.warn('Direct order_lookups fetch fallback to server:', err);
  }

  // Fallback to server lookup for orders created before trackingCode lookup indexing
  try {
    const res = await fetch('/api/orders/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackingCode: cleanCode, phone }),
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        data.error || 'Trop de tentatives. Veuillez patienter quelques minutes.'
      );
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { order?: Order };
    return data.order || null;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Trop de tentatives')) {
      throw err;
    }
    return null;
  }
}

export async function fetchOrderById(orderId: string): Promise<Order | null> {
  try {
    const snap = await getDoc(doc(db, 'orders', orderId));
    return snap.exists() ? (snap.data() as Order) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `orders/${orderId}`);
  }
}

export function subscribeSingleOrder(
  orderId: string,
  onOrder: (order: Order | null) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'orders', orderId),
    (snap) => {
      onOrder(snap.exists() ? (snap.data() as Order) : null);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, `orders/${orderId}`);
    }
  );
}

export async function submitClientPayment(params: {
  order: Order;
  method: PaymentMethod;
  depositPhone: string;
  transactionRef?: string;
  declaredAmount: number;
  paymentType: 'acompte' | 'integral' | 'solde';
  screenshotFileId?: string;
  screenshotPreviewUrl?: string;
}): Promise<Payment> {
  const paymentId = `pay_${randomToken(14)}`;
  const nowIso = new Date().toISOString();

  const paymentData: Payment = {
    paymentId,
    orderId: params.order.orderId,
    orderNumber: params.order.orderNumber,
    customerName: params.order.customerName,
    methodId: params.method.id,
    methodName: params.method.operatorName,
    depositPhone: params.depositPhone.trim(),
    transactionRef: params.transactionRef?.trim() || '',
    declaredAmount: params.declaredAmount,
    paymentType: params.paymentType,
    screenshotFileId: params.screenshotFileId || '',
    screenshotPreviewUrl: params.screenshotPreviewUrl || '',
    status: 'en_attente_validation',
    createdAt: serverTimestamp(),
  };

  const nextHistory = [
    ...params.order.statusHistory,
    {
      status: params.order.status,
      label: 'Paiement déclaré',
      actor: params.order.customerName,
      note: `${params.method.operatorName} · ${params.declaredAmount} FCFA`,
      timestamp: nowIso,
    },
  ];

  const nextPaymentIds = [...(params.order.paymentIds || []), paymentId].slice(-20);

  try {
    await setDoc(doc(db, 'payments', paymentId), sanitizeForFirestore(paymentData));
    await updateDoc(
      doc(db, 'orders', params.order.orderId),
      sanitizeForFirestore({
        paymentStatus: 'en_attente_validation',
        paymentIds: nextPaymentIds,
        latestPayment: {
          paymentId,
          methodName: params.method.operatorName,
          depositPhone: params.depositPhone.trim(),
          transactionRef: params.transactionRef?.trim() || '',
          declaredAmount: params.declaredAmount,
          paymentType: params.paymentType,
          status: 'en_attente_validation',
          createdAt: nowIso,
        },
        statusHistory: nextHistory,
        updatedAt: serverTimestamp(),
      })
    );
    return paymentData;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `payments/${paymentId}`);
  }
}

export async function reuploadCorrectedFile(
  order: Order,
  oldFileId: string,
  newFile: UploadedFileMeta
): Promise<void> {
  const nowIso = new Date().toISOString();
  const updatedFiles = order.files.map((f) =>
    f.fileId === oldFileId ? { ...f, replaced: true } : f
  );
  updatedFiles.push(newFile);

  const nextHistory = [
    ...order.statusHistory,
    {
      status: 'en_verification' as OrderStatus,
      label: ORDER_STATUS_META.en_verification.label,
      actor: order.customerName,
      note: `Nouveau fichier renvoyé : ${newFile.originalName} (v${newFile.version})`,
      timestamp: nowIso,
    },
  ];

  try {
    await updateDoc(
      doc(db, 'orders', order.orderId),
      sanitizeForFirestore({
        files: updatedFiles,
        status: 'en_verification',
        statusHistory: nextHistory,
        updatedAt: serverTimestamp(),
      })
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `orders/${order.orderId}`);
  }
}

// --- Admin & Operator Firestore Operations ---

export async function resolveStaffUser(
  uid: string,
  email: string,
  displayName?: string | null
): Promise<AdminUser | null> {
  const normalizedEmail = email.toLowerCase();
  const userRef = doc(db, 'admin_users', uid);

  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      const existingUser = snap.data() as AdminUser;
      await updateDoc(userRef, {
        lastLoginAt: new Date().toISOString(),
        displayName: displayName || existingUser.displayName || '',
      });
      return existingUser.active ? existingUser : null;
    }

    if (normalizedEmail === 'ouattaraabdoulaye479@gmail.com') {
      const adminProfile: AdminUser = {
        uid,
        email: normalizedEmail,
        displayName: displayName || 'Administrateur FBC Print',
        role: 'admin',
        active: true,
        lastLoginAt: new Date().toISOString(),
        createdAt: serverTimestamp(),
      };
      await setDoc(userRef, adminProfile);
      return adminProfile;
    }

    // Check invitation
    const inviteSnap = await getDoc(doc(db, 'admin_invites', normalizedEmail));
    if (inviteSnap.exists()) {
      const invite = inviteSnap.data() as AdminInvite;
      const profile: AdminUser = {
        uid,
        email: normalizedEmail,
        displayName: displayName || invite.displayName || normalizedEmail,
        role: invite.role,
        active: true,
        lastLoginAt: new Date().toISOString(),
        createdAt: serverTimestamp(),
      };
      await setDoc(userRef, profile);
      return profile;
    }

    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `admin_users/${uid}`);
  }
}

export function subscribeAdminOrders(
  onOrders: (orders: Order[]) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(200)),
    (snap) => {
      onOrders(snap.docs.map((d) => d.data() as Order));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'orders');
    }
  );
}

export function subscribeAdminPayments(
  onPayments: (payments: Payment[]) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'payments'), orderBy('createdAt', 'desc'), limit(200)),
    (snap) => {
      onPayments(snap.docs.map((d) => d.data() as Payment));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'payments');
    }
  );
}

export function subscribeAdminClients(
  onClients: (clients: ClientProfile[]) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'clients'), orderBy('createdAt', 'desc'), limit(200)),
    (snap) => {
      onClients(snap.docs.map((d) => d.data() as ClientProfile));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'clients');
    }
  );
}

export function subscribeAuditLogs(onLogs: (logs: AuditLog[]) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'audit_logs'), orderBy('createdAt', 'desc'), limit(200)),
    (snap) => {
      onLogs(snap.docs.map((d) => d.data() as AuditLog));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    }
  );
}

export async function fetchAuditLogsByRange(
  startDate: Date,
  endDate: Date,
  maxResults = 500
): Promise<AuditLog[]> {
  try {
    const q = query(
      collection(db, 'audit_logs'),
      where('createdAt', '>=', Timestamp.fromDate(startDate)),
      where('createdAt', '<=', Timestamp.fromDate(endDate)),
      orderBy('createdAt', 'desc'),
      limit(maxResults)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as AuditLog);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    throw error;
  }
}

export async function writeAuditLog(params: {
  action: string;
  targetType: string;
  targetId: string;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
  details?: string;
}): Promise<void> {
  const logId = `log_${randomToken(12)}`;
  try {
    await setDoc(
      doc(db, 'audit_logs', logId),
      sanitizeForFirestore({
        logId,
        ...params,
        createdAt: serverTimestamp(),
      })
    );
  } catch (err) {
    console.warn('Audit log write warning:', err);
  }
}

export async function adminUpdateOrderStatus(params: {
  order: Order;
  newStatus: OrderStatus;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
  note?: string;
  correctionMessage?: string;
  cancellationReason?: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const nextHistory = [
    ...params.order.statusHistory,
    {
      status: params.newStatus,
      label: ORDER_STATUS_META[params.newStatus].label,
      actor: params.actorEmail,
      note: params.note || params.correctionMessage || params.cancellationReason || '',
      timestamp: nowIso,
    },
  ];

  const updates: Record<string, unknown> = {
    status: params.newStatus,
    statusHistory: nextHistory,
    updatedAt: serverTimestamp(),
  };

  if (params.correctionMessage !== undefined) {
    updates.correctionRequestMessage = params.correctionMessage;
  }
  if (params.cancellationReason !== undefined) {
    updates.cancellationReason = params.cancellationReason;
  }

  try {
    await updateDoc(doc(db, 'orders', params.order.orderId), sanitizeForFirestore(updates));
    await writeAuditLog({
      action: `Statut → ${ORDER_STATUS_META[params.newStatus].label}`,
      targetType: 'order',
      targetId: params.order.orderNumber,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      details: params.note || params.correctionMessage || params.cancellationReason || '',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `orders/${params.order.orderId}`);
  }
}

export async function adminUpdateOrderFields(
  orderId: string,
  updates: Record<string, unknown>
): Promise<void> {
  try {
    await updateDoc(
      doc(db, 'orders', orderId),
      sanitizeForFirestore({
        ...updates,
        updatedAt: serverTimestamp(),
      })
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `orders/${orderId}`);
  }
}

export async function adminValidatePayment(params: {
  payment: Payment;
  order: Order;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const newPaidAmount = (params.order.paidAmount || 0) + params.payment.declaredAmount;
  const isFullyPaid = newPaidAmount >= params.order.totalAmount;
  const newPaymentStatus = isFullyPaid ? 'paye' : 'partiellement_paye';
  const receiptNumber = params.order.receiptNumber || (await allocateNextReceiptNumber());

  const nextStatus =
    params.order.status === 'recue' ||
    params.order.status === 'en_verification' ||
    params.order.status === 'en_attente_paiement'
      ? 'payee'
      : params.order.status;

  const nextHistory = [
    ...params.order.statusHistory,
    {
      status: nextStatus,
      label: `Paiement validé (${params.payment.methodName})`,
      actor: params.actorEmail,
      note: `${params.payment.declaredAmount} FCFA · Reçu ${receiptNumber}`,
      timestamp: nowIso,
    },
  ];

  try {
    await updateDoc(doc(db, 'payments', params.payment.paymentId), {
      status: 'valide',
      validatedByEmail: params.actorEmail,
      validatedAt: nowIso,
    });

    await updateDoc(doc(db, 'orders', params.order.orderId), {
      paidAmount: newPaidAmount,
      paymentStatus: newPaymentStatus,
      paymentRejectionReason: '',
      receiptNumber,
      status: nextStatus,
      latestPayment: {
        paymentId: params.payment.paymentId,
        methodName: params.payment.methodName,
        depositPhone: params.payment.depositPhone,
        transactionRef: params.payment.transactionRef || '',
        declaredAmount: params.payment.declaredAmount,
        paymentType: params.payment.paymentType,
        status: 'valide',
        validatedAt: nowIso,
        createdAt: nowIso,
      },
      statusHistory: nextHistory,
      updatedAt: serverTimestamp(),
    });

    // Upsert client profile
    const { compact } = normalizeBurkinaPhone(params.order.customerPhone);
    const clientRef = doc(db, 'clients', compact || `cli_${randomToken(8)}`);
    const clientSnap = await getDoc(clientRef);
    if (clientSnap.exists()) {
      const prev = clientSnap.data() as ClientProfile;
      await updateDoc(clientRef, {
        name: params.order.customerName,
        totalOrders: (prev.totalOrders || 0) + 1,
        totalSpent: (prev.totalSpent || 0) + params.payment.declaredAmount,
        lastOrderAt: nowIso,
      });
    } else {
      await setDoc(clientRef, {
        clientId: clientRef.id,
        name: params.order.customerName,
        phone: params.order.customerPhone,
        isWhatsapp: params.order.isWhatsapp,
        address: params.order.deliveryAddress || '',
        notes: '',
        totalOrders: 1,
        totalSpent: params.payment.declaredAmount,
        lastOrderAt: nowIso,
        createdAt: serverTimestamp(),
      });
    }

    await writeAuditLog({
      action: 'Validation paiement',
      targetType: 'payment',
      targetId: params.payment.paymentId,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      details: `${params.order.orderNumber} · ${params.payment.declaredAmount} FCFA (${params.payment.methodName})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `payments/${params.payment.paymentId}`);
  }
}

export async function adminRejectPayment(params: {
  payment: Payment;
  order: Order;
  reason: string;
  actorEmail: string;
  actorRole: 'admin' | 'operator';
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const nextHistory = [
    ...params.order.statusHistory,
    {
      status: params.order.status,
      label: 'Paiement rejeté',
      actor: params.actorEmail,
      note: params.reason,
      timestamp: nowIso,
    },
  ];

  try {
    await updateDoc(doc(db, 'payments', params.payment.paymentId), {
      status: 'rejete',
      rejectionReason: params.reason,
      validatedByEmail: params.actorEmail,
      validatedAt: nowIso,
    });

    await updateDoc(doc(db, 'orders', params.order.orderId), {
      paymentStatus: 'rejete',
      paymentRejectionReason: params.reason,
      latestPayment: {
        paymentId: params.payment.paymentId,
        methodName: params.payment.methodName,
        depositPhone: params.payment.depositPhone,
        transactionRef: params.payment.transactionRef || '',
        declaredAmount: params.payment.declaredAmount,
        paymentType: params.payment.paymentType,
        status: 'rejete',
        rejectionReason: params.reason,
        validatedAt: nowIso,
        createdAt: nowIso,
      },
      statusHistory: nextHistory,
      updatedAt: serverTimestamp(),
    });

    await writeAuditLog({
      action: 'Rejet paiement',
      targetType: 'payment',
      targetId: params.payment.paymentId,
      actorEmail: params.actorEmail,
      actorRole: params.actorRole,
      details: `${params.order.orderNumber} · Motif : ${params.reason}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `payments/${params.payment.paymentId}`);
  }
}

export async function adminSaveService(
  service: PrintService,
  actorEmail: string
): Promise<void> {
  try {
    await setDoc(
      doc(db, 'services', service.id),
      sanitizeForFirestore({
        ...service,
        updatedAt: new Date().toISOString(),
      })
    );
    await writeAuditLog({
      action: 'Mise à jour tarif / prestation',
      targetType: 'service',
      targetId: service.id,
      actorEmail,
      actorRole: 'admin',
      details: `${service.name} (${service.basePrice} FCFA · ${service.active ? 'actif' : 'désactivé'})`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `services/${service.id}`);
  }
}

export async function adminDeleteService(serviceId: string, actorEmail: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'services', serviceId));
    await writeAuditLog({
      action: 'Suppression prestation',
      targetType: 'service',
      targetId: serviceId,
      actorEmail,
      actorRole: 'admin',
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `services/${serviceId}`);
  }
}

export async function adminSavePaymentMethod(
  method: PaymentMethod,
  actorEmail: string
): Promise<void> {
  try {
    await setDoc(doc(db, 'payment_methods', method.id), sanitizeForFirestore(method));
    await writeAuditLog({
      action: 'Modification opérateur Mobile Money',
      targetType: 'payment_method',
      targetId: method.id,
      actorEmail,
      actorRole: 'admin',
      details: `${method.operatorName} · ${method.phoneNumber}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `payment_methods/${method.id}`);
  }
}

export async function adminSaveShopSettings(
  settings: ShopSettings,
  actorEmail: string
): Promise<void> {
  try {
    await setDoc(
      doc(db, 'settings', 'shop'),
      sanitizeForFirestore({
        ...settings,
        updatedAt: new Date().toISOString(),
      })
    );
    await writeAuditLog({
      action: 'Modification réglages boutique',
      targetType: 'settings',
      targetId: 'shop',
      actorEmail,
      actorRole: 'admin',
      details: `Atelier ${settings.isOpen ? 'ouvert' : 'fermé'} · Acompte ${settings.depositPercent}%`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'settings/shop');
  }
}

export async function adminSaveClientNotes(clientId: string, notes: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'clients', clientId), { notes });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `clients/${clientId}`);
  }
}

export async function adminCreateInvite(
  invite: Omit<AdminInvite, 'createdAt'>,
  actorEmail: string
): Promise<void> {
  const emailKey = invite.email.trim().toLowerCase();
  try {
    await setDoc(
      doc(db, 'admin_invites', emailKey),
      sanitizeForFirestore({
        ...invite,
        email: emailKey,
        createdAt: serverTimestamp(),
      })
    );
    await writeAuditLog({
      action: 'Invitation collaborateur',
      targetType: 'admin_invite',
      targetId: emailKey,
      actorEmail,
      actorRole: 'admin',
      details: `Rôle attribué : ${invite.role}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `admin_invites/${emailKey}`);
  }
}

export async function adminListStaff(): Promise<{ users: AdminUser[]; invites: AdminInvite[] }> {
  try {
    const [uSnap, iSnap] = await Promise.all([
      getDocs(collection(db, 'admin_users')),
      getDocs(collection(db, 'admin_invites')),
    ]);
    return {
      users: uSnap.docs.map((d) => d.data() as AdminUser),
      invites: iSnap.docs.map((d) => d.data() as AdminInvite),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'admin_users');
  }
}

export async function adminUpdateStaffStatus(
  uid: string,
  active: boolean,
  role: 'admin' | 'operator',
  actorEmail: string
): Promise<void> {
  try {
    await updateDoc(doc(db, 'admin_users', uid), { active, role });
    await writeAuditLog({
      action: 'Mise à jour rôle/accès collaborateur',
      targetType: 'admin_user',
      targetId: uid,
      actorEmail,
      actorRole: 'admin',
      details: `Rôle : ${role} · Actif : ${active}`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `admin_users/${uid}`);
  }
}
