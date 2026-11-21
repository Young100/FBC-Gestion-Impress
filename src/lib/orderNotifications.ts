import type { Order, OrderStatus, PaymentStatus } from '../types/fbc';
import { ORDER_STATUS_META } from '../types/fbc';
import type { ToastInput, ToastVariant } from '../components/ToastProvider';

export interface OrderSnapshotState {
  orderId: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  historyCount: number;
}

export function extractOrderSnapshot(order: Order): OrderSnapshotState {
  return {
    orderId: order.orderId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    historyCount: Array.isArray(order.statusHistory) ? order.statusHistory.length : 0,
  };
}

function getLatestNote(order: Order): string | undefined {
  if (!Array.isArray(order.statusHistory) || order.statusHistory.length === 0) {
    return undefined;
  }
  const latest = order.statusHistory[order.statusHistory.length - 1];
  const note = latest?.note?.trim();
  return note ? note : undefined;
}

function buildStatusDescriptor(order: Order): {
  title: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
} {
  const note = getLatestNote(order);
  const label = ORDER_STATUS_META[order.status]?.label || order.status;

  switch (order.status) {
    case 'recue':
      return {
        title: `Statut mis à jour : ${label}`,
        message: 'Votre commande a bien été enregistrée par l’atelier.',
        variant: 'info',
        durationMs: 7000,
      };
    case 'en_verification':
      return {
        title: 'Vérification des fichiers en cours',
        message: note
          ? `L’atelier contrôle vos fichiers (${note}).`
          : 'L’atelier contrôle la conformité et la résolution de vos fichiers.',
        variant: 'info',
        durationMs: 8000,
      };
    case 'fichier_a_corriger':
      return {
        title: 'Action requise : fichier à corriger',
        message:
          order.correctionRequestMessage?.trim() ||
          note ||
          'L’imprimeur demande une nouvelle version de votre fichier.',
        variant: 'error',
        durationMs: 12000,
      };
    case 'en_attente_paiement':
      return {
        title: 'En attente de paiement',
        message:
          note ||
          'Votre commande est prête à être réglée par Mobile Money pour lancer la production.',
        variant: 'warning',
        durationMs: 9000,
      };
    case 'payee':
      return {
        title: 'Paiement confirmé !',
        message: note
          ? `Commande validée (${note}). La mise en production va démarrer.`
          : 'Votre paiement a été validé. Votre commande passe en préparation.',
        variant: 'success',
        durationMs: 9000,
      };
    case 'en_production':
      return {
        title: 'Impression en cours',
        message: note
          ? `Votre commande est en fabrication (${note}).`
          : 'Votre commande est actuellement en cours d’impression dans notre atelier.',
        variant: 'info',
        durationMs: 8500,
      };
    case 'prete':
      return {
        title: 'Bonne nouvelle : commande prête !',
        message: order.wantsDelivery
          ? 'Votre commande est terminée et prête pour l’expédition.'
          : 'Votre commande est terminée et prête pour le retrait à l’atelier.',
        variant: 'success',
        durationMs: 11000,
      };
    case 'livree':
      return {
        title: 'Commande livrée',
        message: 'Votre commande a été remise. Merci pour votre confiance !',
        variant: 'success',
        durationMs: 10000,
      };
    case 'annulee':
      return {
        title: 'Commande annulée',
        message: order.cancellationReason?.trim()
          ? `Motif : ${order.cancellationReason.trim()}`
          : note || 'Cette commande a été annulée par l’atelier.',
        variant: 'error',
        durationMs: 12000,
      };
  }
}

function buildPaymentDescriptor(order: Order): {
  title: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
} | null {
  switch (order.paymentStatus) {
    case 'paye':
      return {
        title: 'Paiement intégral validé',
        message: order.receiptNumber
          ? `Votre reçu officiel (${order.receiptNumber}) est prêt au téléchargement.`
          : 'Votre paiement a été validé par l’atelier.',
        variant: 'success',
        durationMs: 9000,
      };
    case 'partiellement_paye':
      return {
        title: 'Acompte validé',
        message: order.receiptNumber
          ? `Votre acompte est confirmé (reçu ${order.receiptNumber}).`
          : 'Votre paiement partiel a été validé par l’atelier.',
        variant: 'success',
        durationMs: 9000,
      };
    case 'rejete':
      return {
        title: 'Justificatif de paiement rejeté',
        message: order.paymentRejectionReason?.trim()
          ? `Motif : ${order.paymentRejectionReason.trim()}`
          : 'Veuillez vérifier votre référence ou joindre une nouvelle capture.',
        variant: 'error',
        durationMs: 12000,
      };
    case 'en_attente_validation':
      return {
        title: 'Paiement transmis à l’atelier',
        message: 'Votre justificatif est en cours de vérification.',
        variant: 'info',
        durationMs: 7000,
      };
    case 'non_paye':
      return null;
  }
}

export function buildOrderChangeToasts(
  prev: OrderSnapshotState,
  next: Order,
  options?: { isOnTrackingView?: boolean; onOpenTracking?: () => void }
): ToastInput[] {
  if (prev.orderId !== next.orderId) return [];

  const notifications: ToastInput[] = [];
  const actionFields =
    !options?.isOnTrackingView && options?.onOpenTracking
      ? {
          actionLabel: 'Voir le suivi',
          onAction: options.onOpenTracking,
        }
      : {};

  if (next.status !== prev.status) {
    const desc = buildStatusDescriptor(next);
    notifications.push({
      id: `order_status_${next.orderId}_${next.status}`,
      badge: next.orderNumber,
      title: desc.title,
      message: desc.message,
      variant: desc.variant,
      durationMs: desc.durationMs,
      ...actionFields,
    });
  }

  // Emit a separate payment toast only if paymentStatus changed AND wasn't already
  // fully announced by the simultaneous transition to 'payee'.
  const paymentChanged = next.paymentStatus !== prev.paymentStatus;
  const redundantPayeeBanner =
    next.status !== prev.status &&
    next.status === 'payee' &&
    (next.paymentStatus === 'paye' || next.paymentStatus === 'partiellement_paye');

  if (paymentChanged && !redundantPayeeBanner) {
    const payDesc = buildPaymentDescriptor(next);
    if (payDesc) {
      notifications.push({
        id: `order_payment_${next.orderId}_${next.paymentStatus}`,
        badge: next.orderNumber,
        title: payDesc.title,
        message: payDesc.message,
        variant: payDesc.variant,
        durationMs: payDesc.durationMs,
        ...actionFields,
      });
    }
  }

  return notifications;
}
