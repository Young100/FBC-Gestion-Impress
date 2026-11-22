import {
  ensureWebPushSubscription,
  syncAppIconBadge,
  unsubscribeWebPush,
} from './browserNotifications';
import type {
  ClientAccountPublic,
  Order,
  Payment,
  ServerNotificationItem,
  UploadedFileMeta,
} from '../types/fbc';

let inMemoryClientSessionToken: string | null = null;

export function getClientSessionToken(): string | null {
  return inMemoryClientSessionToken;
}

export function setClientSessionToken(token: string | null | undefined) {
  inMemoryClientSessionToken = token?.trim() || null;
}

export function clearClientSessionToken() {
  inMemoryClientSessionToken = null;
}

export function getClientAuthHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra || {});
  if (inMemoryClientSessionToken) {
    headers.set('X-Client-Session', inMemoryClientSessionToken);
  }
  return headers;
}

export class ClientApiError extends Error {
  status: number;
  requiresAuth?: boolean;
  constructor(message: string, status: number, requiresAuth?: boolean) {
    super(message);
    this.status = status;
    this.requiresAuth = requiresAuth;
  }
}

async function clientFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = getClientAuthHeaders(init.headers);
  if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const method = (init.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 2 : 1;

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
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      throw new ClientApiError(
        'Connexion au serveur interrompue. Vérifiez votre réseau et réessayez.',
        0
      );
    }

    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 900));
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new ClientApiError(
        res.ok
          ? 'Réponse serveur invalide (format JSON attendu).'
          : `Erreur serveur (${res.status}).`,
        res.status
      );
    }

    let data: (T & { error?: string; requiresAuth?: boolean }) | null = null;
    try {
      data = (await res.json()) as T & { error?: string; requiresAuth?: boolean };
    } catch {
      throw new ClientApiError(`Réponse serveur illisible (${res.status}).`, res.status);
    }

    if (!res.ok) {
      if (res.status === 401) {
        clearClientSessionToken();
      }
      throw new ClientApiError(
        data?.error || `Erreur serveur (${res.status}).`,
        res.status,
        Boolean(data?.requiresAuth)
      );
    }

    return (data ?? {}) as T;
  }

  throw new ClientApiError('Impossible de joindre le serveur.', 0);
}

export async function fetchClientSession(): Promise<{
  authenticated: boolean;
  account?: ClientAccountPublic;
}> {
  const res = await clientFetch<{
    authenticated: boolean;
    account?: ClientAccountPublic;
  }>('/api/client/session');
  if (!res.authenticated) {
    clearClientSessionToken();
  }
  return res;
}

export async function registerClientAccount(params: {
  username: string;
  fullName: string;
  phone: string;
  password: string;
  claimTrackingCode?: string;
}): Promise<{ account: ClientAccountPublic; claimedOrder?: Order }> {
  const res = await clientFetch<{
    sessionToken?: string;
    account: ClientAccountPublic;
    claimedOrder?: Order;
  }>('/api/client/register', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  if (res.sessionToken) {
    setClientSessionToken(res.sessionToken);
  }
  return {
    account: res.account,
    claimedOrder: res.claimedOrder,
  };
}

export async function loginClientAccount(
  identifier: string,
  password: string
): Promise<ClientAccountPublic> {
  const res = await clientFetch<{
    sessionToken?: string;
    account: ClientAccountPublic;
  }>('/api/client/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
  if (res.sessionToken) {
    setClientSessionToken(res.sessionToken);
  }
  return res.account;
}

export async function logoutClientAccount(): Promise<void> {
  try {
    await unsubscribeWebPush({
      swScope: '/client/',
      unsubscribeUrl: '/api/client/push/unsubscribe',
      getHeaders: () => getClientAuthHeaders({ 'Content-Type': 'application/json' }),
    });
  } catch {
    // Ignore push unsubscribe issues on logout
  }
  await syncAppIconBadge(0, '/client/');
  clearClientSessionToken();
  try {
    await clientFetch('/api/client/logout', { method: 'POST' });
  } catch {
    // Ignore logout network failures after local token clear
  }
}

export async function changeClientPassword(
  currentPassword: string,
  newPassword: string
): Promise<ClientAccountPublic> {
  const res = await clientFetch<{ account: ClientAccountPublic }>(
    '/api/client/change-password',
    {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }
  );
  return res.account;
}

export async function fetchMyOrders(): Promise<Order[]> {
  const res = await clientFetch<{ orders?: Order[] }>('/api/client/orders');
  return Array.isArray(res.orders) ? res.orders : [];
}

export async function claimOrderByTrackingCode(
  trackingCode: string
): Promise<{ order: Order; claimed: boolean }> {
  return clientFetch<{ order: Order; claimed: boolean }>('/api/client/claim-order', {
    method: 'POST',
    body: JSON.stringify({ trackingCode }),
  });
}

export async function openOrderByTrackingCode(
  trackingCode: string
): Promise<{ order: Order; claimed: boolean }> {
  return clientFetch<{ order: Order; claimed: boolean }>('/api/client/orders/open-link', {
    method: 'POST',
    body: JSON.stringify({ trackingCode }),
  });
}

export async function createClientOrder(
  payload: Record<string, unknown>
): Promise<Order> {
  const res = await clientFetch<{ order: Order }>('/api/client/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.order;
}

export async function declareClientPayment(
  orderId: string,
  params: {
    methodId: string;
    methodName: string;
    depositPhone: string;
    transactionRef?: string;
    declaredAmount: number;
    paymentType: 'acompte' | 'integral' | 'solde';
    screenshotFileId?: string;
    screenshotPreviewUrl?: string;
  }
): Promise<{ payment: Payment; order: Order }> {
  return clientFetch<{ payment: Payment; order: Order }>(
    `/api/client/orders/${encodeURIComponent(orderId)}/payments`,
    {
      method: 'POST',
      body: JSON.stringify(params),
    }
  );
}

export async function reuploadClientCorrectedFile(
  orderId: string,
  oldFileId: string,
  newFile: UploadedFileMeta
): Promise<Order> {
  const res = await clientFetch<{ order: Order }>(
    `/api/client/orders/${encodeURIComponent(orderId)}/reupload`,
    {
      method: 'POST',
      body: JSON.stringify({ oldFileId, newFile }),
    }
  );
  return res.order;
}

export async function triggerClientProtectedDownload(
  url: string,
  filename: string
): Promise<void> {
  const res = await fetch(url, {
    headers: getClientAuthHeaders(),
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error('Impossible de télécharger ce fichier.');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

export async function subscribeClientWebPush(): Promise<boolean> {
  if (!inMemoryClientSessionToken) {
    // Still works if httpOnly session cookie is active
  }
  return ensureWebPushSubscription({
    swScope: '/client/',
    subscribeUrl: '/api/client/push/subscribe',
    getHeaders: () => getClientAuthHeaders({ 'Content-Type': 'application/json' }),
  });
}

export async function unsubscribeClientWebPush(): Promise<void> {
  await unsubscribeWebPush({
    swScope: '/client/',
    unsubscribeUrl: '/api/client/push/unsubscribe',
    getHeaders: () => getClientAuthHeaders({ 'Content-Type': 'application/json' }),
  });
}

export async function resetClientPushBadge(): Promise<void> {
  await syncAppIconBadge(0, '/client/');
  try {
    await clientFetch('/api/client/push/badge-reset', { method: 'POST' });
  } catch {
    // Ignore badge reset network failures
  }
}

export async function sendClientTestPush(): Promise<{ delivered: number }> {
  const res = await clientFetch<{ delivered?: number }>('/api/client/push/test', {
    method: 'POST',
  });
  return { delivered: Number(res.delivered || 0) };
}

export async function fetchClientNotifications(): Promise<{
  notifications: ServerNotificationItem[];
  unreadCount: number;
}> {
  const res = await clientFetch<{
    notifications?: ServerNotificationItem[];
    unreadCount?: number;
  }>('/api/client/notifications');
  return {
    notifications: Array.isArray(res.notifications) ? res.notifications : [],
    unreadCount: Number(res.unreadCount || 0),
  };
}

export async function markClientNotificationsRead(notifId?: string): Promise<void> {
  await clientFetch('/api/client/notifications/mark-read', {
    method: 'POST',
    body: JSON.stringify(notifId ? { notifId } : {}),
  });
  if (!notifId) {
    await syncAppIconBadge(0, '/client/');
  }
}

