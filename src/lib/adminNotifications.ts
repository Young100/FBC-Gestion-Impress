import type { ToastInput } from '../components/ToastProvider';
import { formatFcfa } from './pricing';
import {
  ORDER_STATUS_META,
  type Order,
  type OrderStatus,
  type Payment,
  type PaymentStatus,
} from '../types/fbc';

export interface AdminOrderBrief {
  orderId: string;
  orderNumber: string;
  customerName: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  urgent: boolean;
  totalAmount: number;
  activeFilesCount: number;
  itemCount: number;
}

export interface AdminPaymentBrief {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  methodName: string;
  declaredAmount: number;
  status: Payment['status'];
}

export interface AdminSnapshotState {
  ordersById: Map<string, AdminOrderBrief>;
  paymentsById: Map<string, AdminPaymentBrief>;
}

export interface AdminAlertItem {
  toast: ToastInput;
  nativeTitle: string;
  nativeBody: string;
  nativeTag: string;
  nativeUrl: string;
  requireInteraction?: boolean;
}

export function extractAdminSnapshot(
  orders: Order[],
  payments: Payment[]
): AdminSnapshotState {
  const ordersById = new Map<string, AdminOrderBrief>();
  for (const o of orders) {
    ordersById.set(o.orderId, {
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      status: o.status,
      paymentStatus: o.paymentStatus,
      urgent: Boolean(o.urgent),
      totalAmount: o.totalAmount || 0,
      activeFilesCount: Array.isArray(o.files)
        ? o.files.filter((f) => !f.replaced).length
        : 0,
      itemCount: Array.isArray(o.items) ? o.items.length : 0,
    });
  }

  const paymentsById = new Map<string, AdminPaymentBrief>();
  for (const p of payments) {
    paymentsById.set(p.paymentId, {
      paymentId: p.paymentId,
      orderId: p.orderId,
      orderNumber: p.orderNumber,
      customerName: p.customerName,
      methodName: p.methodName,
      declaredAmount: p.declaredAmount || 0,
      status: p.status,
    });
  }

  return { ordersById, paymentsById };
}

function getLatestActor(order: Order): string | undefined {
  if (!Array.isArray(order.statusHistory) || order.statusHistory.length === 0) {
    return undefined;
  }
  return order.statusHistory[order.statusHistory.length - 1]?.actor;
}

export function buildAdminChangeAlerts(params: {
  prev: AdminSnapshotState;
  nextOrders: Order[];
  nextPayments: Payment[];
  ordersReady: boolean;
  paymentsReady: boolean;
  staffRole: 'admin' | 'operator';
  staffEmail: string;
  onOpenOrder: (orderId: string) => void;
  onOpenPaymentsTab: () => void;
}): AdminAlertItem[] {
  const {
    prev,
    nextOrders,
    nextPayments,
    ordersReady,
    paymentsReady,
    staffRole,
    staffEmail,
    onOpenOrder,
    onOpenPaymentsTab,
  } = params;

  const isAdmin = staffRole === 'admin';
  const normalizedStaffEmail = staffEmail.trim().toLowerCase();
  const alerts: AdminAlertItem[] = [];
  const paymentAlertedOrderIds = new Set<string>();

  if (ordersReady) {
    for (const order of nextOrders) {
      const old = prev.ordersById.get(order.orderId);
      const lastActor = getLatestActor(order)?.trim().toLowerCase();
      const isSelfAction = Boolean(lastActor && lastActor === normalizedStaffEmail);

      // 1. New Order Received
      if (!old) {
        if (isSelfAction) continue;
        const itemsCount = Array.isArray(order.items) ? order.items.length : 0;
        const serviceSummary = order.items
          ?.slice(0, 2)
          .map((i) => i.serviceName)
          .join(', ');
        const urgentPrefix = order.urgent ? 'Commande URGENTE reçue' : 'Nouvelle commande reçue';
        const message = isAdmin
          ? `${order.customerName} · ${itemsCount} article(s) (${serviceSummary || 'impression'}) · ${formatFcfa(order.totalAmount)}`
          : `${order.customerName} · ${itemsCount} article(s) (${serviceSummary || 'impression'})`;

        alerts.push({
          toast: {
            id: `admin_new_order_${order.orderId}`,
            badge: order.urgent ? `${order.orderNumber} · URGENT` : order.orderNumber,
            title: urgentPrefix,
            message,
            variant: order.urgent ? 'error' : 'info',
            durationMs: order.urgent ? 12000 : 9000,
            actionLabel: 'Ouvrir la commande',
            onAction: () => onOpenOrder(order.orderId),
          },
          nativeTitle: `${urgentPrefix} (${order.orderNumber})`,
          nativeBody: message,
          nativeTag: `fbc-atelier-order-${order.orderId}`,
          nativeUrl: '/fbcprintgestionadmin/',
          requireInteraction: order.urgent,
        });
        continue;
      }

      const nextActiveFiles = Array.isArray(order.files)
        ? order.files.filter((f) => !f.replaced).length
        : 0;

      // 2. Client re-uploaded a corrected file
      const clientReuploaded =
        (old.status === 'fichier_a_corriger' && order.status === 'en_verification') ||
        (old.status === 'fichier_a_corriger' && nextActiveFiles > old.activeFilesCount);

      if (clientReuploaded) {
        const msg = `${order.customerName} a renvoyé un fichier corrigé pour vérification.`;
        alerts.push({
          toast: {
            id: `admin_reupload_${order.orderId}_${nextActiveFiles}`,
            badge: order.orderNumber,
            title: 'Fichier corrigé renvoyé par le client',
            message: msg,
            variant: 'warning',
            durationMs: 10000,
            actionLabel: 'Vérifier le fichier',
            onAction: () => onOpenOrder(order.orderId),
          },
          nativeTitle: `Fichier corrigé reçu (${order.orderNumber})`,
          nativeBody: msg,
          nativeTag: `fbc-atelier-reupload-${order.orderId}`,
          nativeUrl: '/fbcprintgestionadmin/',
        });
        continue;
      }

      // 3. Payment validated on an existing order -> notify operator/admin to start production!
      const becamePaid =
        old.paymentStatus !== order.paymentStatus &&
        (order.paymentStatus === 'paye' || order.paymentStatus === 'partiellement_paye');

      if (becamePaid && !isSelfAction) {
        const payMsg = `${order.customerName} · ${order.paymentStatus === 'paye' ? 'Paiement intégral validé' : 'Acompte validé'} — prête pour production.`;
        alerts.push({
          toast: {
            id: `admin_paid_${order.orderId}_${order.paymentStatus}`,
            badge: order.orderNumber,
            title: 'Paiement confirmé · Prêt à imprimer',
            message: payMsg,
            variant: 'success',
            durationMs: 9000,
            actionLabel: 'Voir la commande',
            onAction: () => onOpenOrder(order.orderId),
          },
          nativeTitle: `Paiement confirmé (${order.orderNumber})`,
          nativeBody: payMsg,
          nativeTag: `fbc-atelier-paid-${order.orderId}`,
          nativeUrl: '/fbcprintgestionadmin/',
        });
      }

      // 4. Order status changed by another team member (skip if already covered above)
      if (old.status !== order.status && !becamePaid && !isSelfAction) {
        const statusLabel = ORDER_STATUS_META[order.status]?.label || order.status;
        const statusMsg = `${order.customerName} est passée au statut « ${statusLabel} ».`;
        alerts.push({
          toast: {
            id: `admin_status_${order.orderId}_${order.status}`,
            badge: order.orderNumber,
            title: `Statut mis à jour : ${statusLabel}`,
            message: statusMsg,
            variant:
              order.status === 'annulee' || order.status === 'fichier_a_corriger'
                ? 'warning'
                : order.status === 'prete' || order.status === 'livree'
                  ? 'success'
                  : 'info',
            durationMs: 7500,
            actionLabel: 'Voir la commande',
            onAction: () => onOpenOrder(order.orderId),
          },
          nativeTitle: `${order.orderNumber} : ${statusLabel}`,
          nativeBody: statusMsg,
          nativeTag: `fbc-atelier-status-${order.orderId}`,
          nativeUrl: '/fbcprintgestionadmin/',
        });
      }
    }
  }

  // 5. Pending Payments to Verify (primarily for Admin; payment records arrive in real time)
  if (paymentsReady && isAdmin) {
    for (const pay of nextPayments) {
      const oldPay = prev.paymentsById.get(pay.paymentId);
      const becamePending =
        pay.status === 'en_attente_validation' &&
        (!oldPay || oldPay.status !== 'en_attente_validation');

      if (!becamePending) continue;

      paymentAlertedOrderIds.add(pay.orderId);
      const hasScreenshot = Boolean(pay.screenshotPreviewUrl);
      const msg = `${pay.customerName} · ${formatFcfa(pay.declaredAmount)} via ${pay.methodName}${hasScreenshot ? '' : ' (sans capture)'}`;

      alerts.push({
        toast: {
          id: `admin_pay_pending_${pay.paymentId}`,
          badge: pay.orderNumber,
          title: 'Paiement à vérifier',
          message: msg,
          variant: hasScreenshot ? 'warning' : 'error',
          durationMs: 11000,
          actionLabel: 'Vérifier le paiement',
          onAction: onOpenPaymentsTab,
        },
        nativeTitle: `Paiement à vérifier (${pay.orderNumber})`,
        nativeBody: msg,
        nativeTag: `fbc-atelier-pay-${pay.paymentId}`,
        nativeUrl: '/fbcprintgestionadmin/',
        requireInteraction: true,
      });
    }
  }

  // Fallback for Admin if order.paymentStatus flipped to en_attente_validation before payment doc synced
  if (ordersReady && isAdmin) {
    for (const order of nextOrders) {
      if (paymentAlertedOrderIds.has(order.orderId)) continue;
      const old = prev.ordersById.get(order.orderId);
      if (
        old &&
        old.paymentStatus !== 'en_attente_validation' &&
        order.paymentStatus === 'en_attente_validation'
      ) {
        const msg = `${order.customerName} a déclaré un paiement (${formatFcfa(order.totalAmount)}).`;
        alerts.push({
          toast: {
            id: `admin_order_pay_pending_${order.orderId}`,
            badge: order.orderNumber,
            title: 'Paiement à vérifier',
            message: msg,
            variant: 'warning',
            durationMs: 10000,
            actionLabel: 'Vérifier le paiement',
            onAction: onOpenPaymentsTab,
          },
          nativeTitle: `Paiement à vérifier (${order.orderNumber})`,
          nativeBody: msg,
          nativeTag: `fbc-atelier-order-pay-${order.orderId}`,
          nativeUrl: '/fbcprintgestionadmin/',
          requireInteraction: true,
        });
      }
    }
  }

  return alerts;
}
