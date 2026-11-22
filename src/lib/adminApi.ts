import {
  ensureWebPushSubscription,
  syncAppIconBadge,
  unsubscribeWebPush,
} from './browserNotifications';
import { auth } from './firebase';
import {
  ORDER_STATUS_META,
  type AdminClientAccountSummary,
  type AdminUser,
  type AuditLog,
  type ClientAccountPublic,
  type ClientProfile,
  type Order,
  type OrderStatus,
  type Payment,
  type PaymentMethod,
  type PrintService,
  type ServerNotificationItem,
  type ShopSettings,
  type StaffCredentialPublic,
} from '../types/fbc';

const STAFF_SESSION_STORAGE_KEY = 'fbc_staff_session_token';
let inMemoryStaffSessionToken: string | null = null;

function getStaffSessionToken(): string | null {
  if (inMemoryStaffSessionToken) return inMemoryStaffSessionToken;
  try {
    const stored = window.sessionStorage.getItem(STAFF_SESSION_STORAGE_KEY);
    if (stored) {
      inMemoryStaffSessionToken = stored;
      return stored;
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return null;
}

function setStaffSessionToken(token: string | null | undefined) {
  const clean = token?.trim() || null;
  inMemoryStaffSessionToken = clean;
  try {
    if (clean) {
      window.sessionStorage.setItem(STAFF_SESSION_STORAGE_KEY, clean);
    } else {
      window.sessionStorage.removeItem(STAFF_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function clearStaffSessionToken() {
  setStaffSessionToken(null);
}

export async function getStaffAuthHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra || {});
  const staffToken = getStaffSessionToken();
  if (staffToken) {
    headers.set('X-Staff-Session', staffToken);
  } else {
    const currentUser = auth.currentUser;
    if (currentUser) {
      try {
        const token = await currentUser.getIdToken();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
      } catch {
        // Ignore token retrieval error; cookie auth may still be present
      }
    }
  }
  return headers;
}

export async function fetchStaffProtectedBlobUrl(url: string): Promise<string> {
  const headers = await getStaffAuthHeaders();
  const res = await fetch(url, {
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Impossible de charger ce fichier (${res.status}).`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function triggerStaffProtectedDownload(
  url: string,
  filename: string
): Promise<void> {
  const objectUrl = await fetchStaffProtectedBlobUrl(url);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

async function adminFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = await getStaffAuthHeaders(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const staffToken = getStaffSessionToken();

  const method = (init.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers,
        credentials: 'include',
      });
    } catch {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw new Error(
        'Connexion au serveur interrompue. Vérifiez votre réseau et réessayez.'
      );
    }

    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new Error(
          `Le serveur est temporairement indisponible ou en cours de redémarrage (${res.status}). Patientez quelques secondes et réessayez.`
        );
      }
      throw new Error(
        res.ok
          ? 'Réponse serveur invalide (format JSON attendu).'
          : `Erreur serveur (${res.status}).`
      );
    }

    let data: (T & { error?: string }) | null = null;
    try {
      data = (await res.json()) as T & { error?: string };
    } catch {
      throw new Error(`Réponse JSON illisible (${res.status}).`);
    }

    if (!res.ok) {
      if (res.status === 401 && staffToken) {
        clearStaffSessionToken();
      }
      throw new Error(data?.error || `Erreur serveur (${res.status})`);
    }
    return (data ?? {}) as T;
  }

  throw new Error('Impossible de joindre le serveur.');
}

export async function fetchStaffSession(): Promise<{
  authenticated: boolean;
  user?: AdminUser;
}> {
  const res = await adminFetch<{ authenticated: boolean; user?: AdminUser }>(
    '/api/staff/session'
  );
  if (!res.authenticated) {
    clearStaffSessionToken();
  }
  return res;
}

export async function loginWithStaffCredentials(
  accessId: string,
  password: string
): Promise<AdminUser> {
  const res = await adminFetch<{ user: AdminUser; sessionToken?: string }>(
    '/api/staff/login',
    {
      method: 'POST',
      body: JSON.stringify({ accessId, password }),
    }
  );
  if (res.sessionToken) {
    setStaffSessionToken(res.sessionToken);
  }
  return res.user;
}

export async function logoutStaffSession(): Promise<void> {
  try {
    await unsubscribeWebPush({
      swScope: '/fbcprintgestionadmin/',
      unsubscribeUrl: '/api/admin/push/unsubscribe',
      getHeaders: () => getStaffAuthHeaders({ 'Content-Type': 'application/json' }),
    });
  } catch {
    // Ignore push unsubscribe error on logout
  }
  await syncAppIconBadge(0, '/fbcprintgestionadmin/');
  clearStaffSessionToken();
  await adminFetch('/api/staff/logout', { method: 'POST' });
}

export async function listStaffAccess(): Promise<{
  credentials: StaffCredentialPublic[];
  googleUsers: AdminUser[];
}> {
  const res = await adminFetch<{
    credentials?: StaffCredentialPublic[];
    googleUsers?: AdminUser[];
  }>('/api/admin/staff-access');
  return {
    credentials: Array.isArray(res?.credentials) ? res.credentials : [],
    googleUsers: Array.isArray(res?.googleUsers) ? res.googleUsers : [],
  };
}

export async function createStaffAccess(params: {
  displayName: string;
  role: 'admin' | 'operator';
  password: string;
}): Promise<StaffCredentialPublic> {
  const res = await adminFetch<{ access: StaffCredentialPublic }>(
    '/api/admin/staff-access',
    {
      method: 'POST',
      body: JSON.stringify(params),
    }
  );
  return res.access;
}

export async function updateStaffAccess(
  accessId: string,
  updates: {
    active?: boolean;
    role?: 'admin' | 'operator';
    displayName?: string;
    password?: string;
  }
): Promise<StaffCredentialPublic> {
  const res = await adminFetch<{ access: StaffCredentialPublic }>(
    `/api/admin/staff-access/${encodeURIComponent(accessId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }
  );
  return res.access;
}

export async function deleteStaffAccess(accessId: string): Promise<void> {
  await adminFetch(`/api/admin/staff-access/${encodeURIComponent(accessId)}`, {
    method: 'DELETE',
  });
}

export async function updateGoogleStaffStatus(
  uid: string,
  active: boolean,
  role: 'admin' | 'operator'
): Promise<void> {
  await adminFetch(`/api/admin/google-staff/${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    body: JSON.stringify({ active, role }),
  });
}

export async function fetchAdminBootstrap(): Promise<{
  orders: Order[];
  payments: Payment[];
  clients: ClientProfile[];
  auditLogs: AuditLog[];
}> {
  const res = await adminFetch<{
    orders?: Order[];
    payments?: Payment[];
    clients?: ClientProfile[];
    auditLogs?: AuditLog[];
  }>('/api/admin/bootstrap');
  return {
    orders: Array.isArray(res?.orders) ? res.orders : [],
    payments: Array.isArray(res?.payments) ? res.payments : [],
    clients: Array.isArray(res?.clients) ? res.clients : [],
    auditLogs: Array.isArray(res?.auditLogs) ? res.auditLogs : [],
  };
}

export async function fetchServerAuditLogsByRange(
  startDate: Date,
  endDate: Date,
  limitCount = 500
): Promise<AuditLog[]> {
  const params = new URLSearchParams({
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    limit: String(limitCount),
  });
  const res = await adminFetch<{ logs?: AuditLog[] }>(
    `/api/admin/audit-logs?${params.toString()}`
  );
  return Array.isArray(res?.logs) ? res.logs : [];
}

export async function createManualOrderServer(
  payload: Record<string, unknown>
): Promise<{ orderId: string; orderNumber: string; order?: Order }> {
  return adminFetch('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateOrderStatusServer(params: {
  orderId: string;
  newStatus: OrderStatus;
  note?: string;
  correctionMessage?: string;
  cancellationReason?: string;
}): Promise<void> {
  await adminFetch(
    `/api/admin/orders/${encodeURIComponent(params.orderId)}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        newStatus: params.newStatus,
        statusLabel: ORDER_STATUS_META[params.newStatus].label,
        note: params.note,
        correctionMessage: params.correctionMessage,
        cancellationReason: params.cancellationReason,
      }),
    }
  );
}

export async function updateOrderFieldsServer(
  orderId: string,
  updates: Record<string, unknown>
): Promise<void> {
  await adminFetch(`/api/admin/orders/${encodeURIComponent(orderId)}/fields`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function validatePaymentServer(paymentId: string): Promise<void> {
  await adminFetch(`/api/admin/payments/${encodeURIComponent(paymentId)}/validate`, {
    method: 'POST',
  });
}

export async function rejectPaymentServer(
  paymentId: string,
  reason: string
): Promise<void> {
  await adminFetch(`/api/admin/payments/${encodeURIComponent(paymentId)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function saveClientNotesServer(
  clientId: string,
  notes: string
): Promise<void> {
  await adminFetch(`/api/admin/clients/${encodeURIComponent(clientId)}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ notes }),
  });
}

export async function saveServiceServer(service: PrintService): Promise<void> {
  await adminFetch(`/api/admin/services/${encodeURIComponent(service.id)}`, {
    method: 'PUT',
    body: JSON.stringify(service),
  });
}

export async function deleteServiceServer(serviceId: string): Promise<void> {
  await adminFetch(`/api/admin/services/${encodeURIComponent(serviceId)}`, {
    method: 'DELETE',
  });
}

export async function savePaymentMethodServer(
  method: PaymentMethod
): Promise<void> {
  await adminFetch(`/api/admin/payment-methods/${encodeURIComponent(method.id)}`, {
    method: 'PUT',
    body: JSON.stringify(method),
  });
}

export async function saveShopSettingsServer(
  settings: ShopSettings
): Promise<void> {
  await adminFetch('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export async function fetchAdminClientAccounts(): Promise<AdminClientAccountSummary[]> {
  const res = await adminFetch<{ accounts?: AdminClientAccountSummary[] }>(
    '/api/admin/client-accounts'
  );
  return Array.isArray(res?.accounts) ? res.accounts : [];
}

export async function resetClientAccountPasswordServer(
  accountId: string,
  newPassword?: string
): Promise<{ temporaryPassword: string; account: ClientAccountPublic }> {
  return adminFetch<{ temporaryPassword: string; account: ClientAccountPublic }>(
    `/api/admin/client-accounts/${encodeURIComponent(accountId)}/reset-password`,
    {
      method: 'POST',
      body: JSON.stringify(newPassword ? { newPassword } : {}),
    }
  );
}

export async function toggleClientAccountActiveServer(
  accountId: string,
  active: boolean
): Promise<ClientAccountPublic> {
  const res = await adminFetch<{ account: ClientAccountPublic }>(
    `/api/admin/client-accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    }
  );
  return res.account;
}

export async function subscribeAdminWebPush(): Promise<boolean> {
  return ensureWebPushSubscription({
    swScope: '/fbcprintgestionadmin/',
    subscribeUrl: '/api/admin/push/subscribe',
    getHeaders: () => getStaffAuthHeaders({ 'Content-Type': 'application/json' }),
  });
}

export async function unsubscribeAdminWebPush(): Promise<void> {
  await unsubscribeWebPush({
    swScope: '/fbcprintgestionadmin/',
    unsubscribeUrl: '/api/admin/push/unsubscribe',
    getHeaders: () => getStaffAuthHeaders({ 'Content-Type': 'application/json' }),
  });
}

export async function resetAdminPushBadge(): Promise<void> {
  await syncAppIconBadge(0, '/fbcprintgestionadmin/');
  try {
    await adminFetch('/api/admin/push/badge-reset', { method: 'POST' });
  } catch {
    // Ignore badge reset error
  }
}

export async function sendAdminTestPush(): Promise<{ delivered: number }> {
  const res = await adminFetch<{ delivered?: number }>('/api/admin/push/test', {
    method: 'POST',
  });
  return { delivered: Number(res.delivered || 0) };
}

export async function notifyOrderPushServer(params: {
  orderId: string;
  eventType: 'status_changed' | 'payment_validated' | 'payment_rejected' | 'manual_order';
  newStatus?: OrderStatus;
  note?: string;
  correctionMessage?: string;
  cancellationReason?: string;
  amount?: number;
  methodName?: string;
  receiptNumber?: string;
  reason?: string;
}): Promise<void> {
  try {
    await adminFetch('/api/admin/push/notify-order', {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        statusLabel: params.newStatus ? ORDER_STATUS_META[params.newStatus].label : undefined,
      }),
    });
  } catch {
    // Never block admin action if push notification fails
  }
}

export async function fetchAdminNotifications(): Promise<{
  notifications: ServerNotificationItem[];
  unreadCount: number;
}> {
  const res = await adminFetch<{
    notifications?: ServerNotificationItem[];
    unreadCount?: number;
  }>('/api/admin/notifications');
  return {
    notifications: Array.isArray(res.notifications) ? res.notifications : [],
    unreadCount: Number(res.unreadCount || 0),
  };
}

export async function markAdminNotificationsRead(notifId?: string): Promise<void> {
  await adminFetch('/api/admin/notifications/mark-read', {
    method: 'POST',
    body: JSON.stringify(notifId ? { notifId } : {}),
  });
  if (!notifId) {
    await syncAppIconBadge(0, '/fbcprintgestionadmin/');
  }
}


