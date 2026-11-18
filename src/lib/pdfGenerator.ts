import { jsPDF } from 'jspdf';
import type { Order, Payment, ShopSettings } from '../types/fbc';
import { formatFcfa } from './pricing';

let cachedLogoDataUrl: string | null = null;

async function getHorizontalLogoPng(): Promise<string | null> {
  if (cachedLogoDataUrl) return cachedLogoDataUrl;
  try {
    const res = await fetch('/assets/aistudio/logo_horizontal_123c69c3.svg');
    const svgText = await res.text();
    const img = new Image();
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = 1176;
    canvas.height = 730;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    cachedLogoDataUrl = canvas.toDataURL('image/png');
    return cachedLogoDataUrl;
  } catch {
    return null;
  }
}

function drawFooter(doc: jsPDF, settings: ShopSettings, pageHeight: number) {
  doc.setDrawColor(38, 84, 124);
  doc.setLineWidth(0.4);
  doc.line(15, pageHeight - 22, 195, pageHeight - 22);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(75, 85, 99);
  doc.text(
    `${settings.shopName} · ${settings.address}`,
    15,
    pageHeight - 16
  );
  doc.text(
    `Tél / WhatsApp : ${settings.phone} · E-mail : ${settings.email}`,
    15,
    pageHeight - 11
  );
}

export async function generateQuotePdf(order: Order, settings: ShopSettings): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const logoPng = await getHorizontalLogoPng();

  // Header band
  doc.setFillColor(237, 242, 244); // #EDF2F4
  doc.rect(0, 0, 210, 46, 'F');

  if (logoPng) {
    doc.addImage(logoPng, 'PNG', 8, 3, 64, 39.7);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor(38, 84, 124);
    doc.text('FBC Print', 15, 26);
  }

  doc.setFillColor(38, 84, 124); // #26547C
  doc.roundedRect(128, 11, 67, 24, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('DEVIS OFFICIEL', 161.5, 20, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(`N° ${order.quoteNumber}`, 161.5, 26, { align: 'center' });
  doc.text(`Commande : ${order.orderNumber}`, 161.5, 31, { align: 'center' });

  // Client & Dates info
  let y = 55;
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('Client', 15, y);
  doc.text('Détails du devis', 125, y);

  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(`Nom : ${order.customerName}`, 15, y);
  const createdStr = order.createdAtIso
    ? new Date(order.createdAtIso).toLocaleDateString('fr-FR')
    : new Date().toLocaleDateString('fr-FR');
  doc.text(`Date d'émission : ${createdStr}`, 125, y);

  y += 5.5;
  doc.text(`Téléphone : ${order.customerPhone}${order.isWhatsapp ? ' (WhatsApp)' : ''}`, 15, y);
  doc.text(
    `Valable jusqu’au : ${new Date(order.quoteValidUntil).toLocaleDateString('fr-FR')}`,
    125,
    y
  );

  y += 5.5;
  doc.text(
    order.wantsDelivery
      ? `Livraison : ${order.deliveryZoneName || ''} — ${order.deliveryAddress || ''}`
      : 'Mode de retrait : À l’agence FBC Print',
    15,
    y,
    { maxWidth: 100 }
  );
  doc.text(`Code de suivi : ${order.trackingCode}`, 125, y);

  // Items Table Header
  y += 14;
  doc.setFillColor(38, 84, 124);
  doc.rect(15, y, 180, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('PRESTATION & CARACTÉRISTIQUES', 18, y + 6);
  doc.text('QTÉ', 124, y + 6, { align: 'right' });
  doc.text('P.U.', 155, y + 6, { align: 'right' });
  doc.text('SOUS-TOTAL', 192, y + 6, { align: 'right' });

  y += 14;
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'normal');

  for (const item of order.items) {
    if (y > 240) {
      doc.addPage();
      y = 20;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(item.serviceName, 18, y);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(75, 85, 99);
    const descLines = doc.splitTextToSize(
      item.summaryText + (item.notes ? ` · Note : ${item.notes}` : ''),
      92
    );
    doc.text(descLines, 18, y + 4.5);

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(9.5);
    doc.text(String(item.quantity), 124, y, { align: 'right' });
    doc.text(formatFcfa(item.unitPrice), 155, y, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    doc.text(formatFcfa(item.subtotal), 192, y, { align: 'right' });

    const blockHeight = Math.max(10, descLines.length * 4.5 + 6);
    doc.setDrawColor(226, 232, 240);
    doc.line(15, y + blockHeight - 2, 195, y + blockHeight - 2);
    y += blockHeight + 3;
  }

  // Totals block
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text('Sous-total prestations :', 125, y);
  doc.text(formatFcfa(order.subtotal), 192, y, { align: 'right' });

  if (order.deliveryFee > 0) {
    y += 6;
    doc.text('Frais de livraison :', 125, y);
    doc.text(formatFcfa(order.deliveryFee), 192, y, { align: 'right' });
  }
  if (order.urgentFee > 0) {
    y += 6;
    doc.text('Majoration urgence :', 125, y);
    doc.text(formatFcfa(order.urgentFee), 192, y, { align: 'right' });
  }
  if (order.discountAmount > 0) {
    y += 6;
    doc.text('Remise commerciale :', 125, y);
    doc.text(`- ${formatFcfa(order.discountAmount)}`, 192, y, { align: 'right' });
  }

  y += 8;
  doc.setFillColor(239, 35, 60); // #EF233C accent red
  doc.roundedRect(120, y, 75, 13, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('TOTAL À PAYER :', 124, y + 8.5);
  doc.text(formatFcfa(order.totalAmount), 191, y + 8.5, { align: 'right' });

  if (order.depositRequiredAmount > 0 && order.depositRequiredAmount < order.totalAmount) {
    y += 18;
    doc.setTextColor(17, 157, 164); // #119DA4
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(
      `Acompte minimum demandé (${settings.depositPercent}%) : ${formatFcfa(order.depositRequiredAmount)}`,
      195,
      y,
      { align: 'right' }
    );
  }

  // Terms
  y += 14;
  doc.setTextColor(38, 84, 124);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('Conditions de commande', 15, y);
  y += 5;
  doc.setTextColor(75, 85, 99);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);
  const termsLines = doc.splitTextToSize(settings.termsText, 180);
  doc.text(termsLines, 15, y);

  drawFooter(doc, settings, 297);
  doc.save(`${order.quoteNumber}_${order.orderNumber}.pdf`);
}

export async function generateReceiptPdf(
  order: Order,
  settings: ShopSettings,
  payment?: Payment | null
): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const logoPng = await getHorizontalLogoPng();

  doc.setFillColor(237, 242, 244);
  doc.rect(0, 0, 210, 46, 'F');

  if (logoPng) {
    doc.addImage(logoPng, 'PNG', 8, 3, 64, 39.7);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor(38, 84, 124);
    doc.text('FBC Print', 15, 26);
  }

  doc.setFillColor(38, 84, 124);
  doc.roundedRect(124, 11, 71, 24, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.text('REÇU DE PAIEMENT', 159.5, 20, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(`N° ${order.receiptNumber || 'REC-' + order.orderNumber}`, 159.5, 26, {
    align: 'center',
  });
  doc.text(`Commande : ${order.orderNumber}`, 159.5, 31, { align: 'center' });

  let y = 56;
  doc.setTextColor(46, 158, 107); // #2E9E6B
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('PAIEMENT VALIDÉ PAR L’ATELIER FBC PRINT', 15, y);

  y += 10;
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Client : ${order.customerName}`, 15, y);
  doc.text(
    `Date de validation : ${
      payment?.validatedAt
        ? new Date(payment.validatedAt).toLocaleString('fr-FR')
        : new Date().toLocaleString('fr-FR')
    }`,
    115,
    y
  );

  y += 6.5;
  doc.text(`Téléphone : ${order.customerPhone}`, 15, y);
  doc.text(
    `Moyen : ${payment?.methodName || order.latestPayment?.methodName || 'Mobile Money'}`,
    115,
    y
  );

  if (payment?.transactionRef || order.latestPayment?.transactionRef) {
    y += 6.5;
    doc.text(
      `Référence : ${payment?.transactionRef || order.latestPayment?.transactionRef}`,
      115,
      y
    );
  }

  y += 12;
  doc.setFillColor(237, 242, 244);
  doc.roundedRect(15, y, 180, 34, 3, 3, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text('Montant total de la commande :', 22, y + 10);
  doc.text(formatFcfa(order.totalAmount), 188, y + 10, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(46, 158, 107);
  doc.text('Montant payé et validé :', 22, y + 19);
  doc.text(formatFcfa(order.paidAmount), 188, y + 19, { align: 'right' });

  const remaining = Math.max(0, order.totalAmount - order.paidAmount);
  doc.setTextColor(remaining > 0 ? 239 : 38, remaining > 0 ? 35 : 84, remaining > 0 ? 60 : 124);
  doc.text('Reste à payer :', 22, y + 28);
  doc.text(formatFcfa(remaining), 188, y + 28, { align: 'right' });

  y += 48;
  doc.setTextColor(38, 84, 124);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Prestations concernées', 15, y);
  y += 6;
  doc.setTextColor(55, 65, 81);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  for (const item of order.items) {
    doc.text(`• ${item.serviceName} — ${item.summaryText} (${formatFcfa(item.subtotal)})`, 15, y);
    y += 5.5;
  }

  drawFooter(doc, settings, 297);
  doc.save(`${order.receiptNumber || 'RECU'}_${order.orderNumber}.pdf`);
}
