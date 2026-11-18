import React, { useState } from 'react';
import {
  Check,
  Copy,
  CreditCard,
  ImagePlus,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { submitClientPayment } from '../lib/firestoreApi';
import { formatFcfa, normalizeBurkinaPhone } from '../lib/pricing';
import { startResumableUpload } from '../lib/uploadClient';
import type { Order, PaymentMethod, ShopSettings } from '../types/fbc';

interface PaymentDeclarationPanelProps {
  order: Order;
  paymentMethods: PaymentMethod[];
  settings: ShopSettings;
  onSuccess: () => void;
  onCancel?: () => void;
}

export const PaymentDeclarationPanel: React.FC<PaymentDeclarationPanelProps> = ({
  order,
  paymentMethods,
  settings,
  onSuccess,
  onCancel,
}) => {
  const activeMethods = paymentMethods.filter((m) => m.active);
  const [selectedMethodId, setSelectedMethodId] = useState<string>(
    activeMethods[0]?.id || ''
  );

  const remainingAmount = Math.max(0, order.totalAmount - (order.paidAmount || 0));
  const depositAmount =
    order.paidAmount > 0
      ? remainingAmount
      : Math.min(
          remainingAmount,
          order.depositRequiredAmount ||
            Math.round((order.totalAmount * (settings.depositPercent || 70)) / 100)
        );

  const canPayDeposit =
    order.paidAmount === 0 &&
    settings.depositPercent > 0 &&
    settings.depositPercent < 100 &&
    depositAmount < remainingAmount;

  const [paymentType, setPaymentType] = useState<'acompte' | 'integral' | 'solde'>(
    order.paidAmount > 0 ? 'solde' : canPayDeposit ? 'acompte' : 'integral'
  );
  const [depositPhone, setDepositPhone] = useState(order.customerPhone || '');
  const [transactionRef, setTransactionRef] = useState('');
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const selectedMethod =
    activeMethods.find((m) => m.id === selectedMethodId) || activeMethods[0];

  const amountToPay =
    paymentType === 'acompte' ? depositAmount : remainingAmount;

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedMethod) {
      setError('Veuillez sélectionner un opérateur Mobile Money.');
      return;
    }

    const phoneCheck = normalizeBurkinaPhone(depositPhone);
    if (!phoneCheck.valid) {
      setError(phoneCheck.error || 'Numéro de dépôt invalide.');
      return;
    }

    if (!screenshotFile) {
      setError('Veuillez joindre la capture d’écran de confirmation du paiement.');
      return;
    }

    setSubmitting(true);
    try {
      const { promise } = startResumableUpload(
        screenshotFile,
        {
          itemId: 'payment_proof',
          slotKey: 'screenshot',
          slotLabel: `Capture paiement ${selectedMethod.operatorName}`,
        },
        (st) => setUploadPercent(st.percent)
      );

      const uploadedMeta = await promise;

      await submitClientPayment({
        order,
        method: selectedMethod,
        depositPhone: phoneCheck.normalized,
        transactionRef,
        declaredAmount: amountToPay,
        paymentType,
        screenshotFileId: uploadedMeta.fileId,
        screenshotPreviewUrl: `/api/files/${uploadedMeta.fileId}/preview`,
      });

      onSuccess();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Impossible d’envoyer la preuve de paiement.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <h3 className="font-display text-xl sm:text-2xl text-[#26547C]">
            Régler par Mobile Money
          </h3>
          <p className="text-sm text-slate-600 mt-1">
            Commande {order.orderNumber} · Reste à régler :{' '}
            <strong className="text-[#26547C] tabular-nums">
              {formatFcfa(remainingAmount)}
            </strong>
          </p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm font-medium text-slate-500 hover:text-[#26547C] self-start min-h-[44px]"
          >
            Fermer
          </button>
        )}
      </div>

      {/* Payment amount choice (Acompte vs Total) */}
      {canPayDeposit && (
        <div className="space-y-2">
          <span className="block text-sm font-semibold text-[#26547C]">
            Montant à régler maintenant
          </span>
          <div className="grid sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setPaymentType('acompte')}
              className={`p-4 rounded-2xl border-2 text-left transition-all min-h-[44px] ${
                paymentType === 'acompte'
                  ? 'border-[#119DA4] bg-[#119DA4]/5'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="text-xs font-medium text-[#119DA4]">
                Acompte de lancement ({settings.depositPercent}%)
              </div>
              <div className="text-lg font-bold text-[#26547C] mt-0.5 tabular-nums">
                {formatFcfa(depositAmount)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Solde ({formatFcfa(remainingAmount - depositAmount)}) à la livraison
              </div>
            </button>

            <button
              type="button"
              onClick={() => setPaymentType('integral')}
              className={`p-4 rounded-2xl border-2 text-left transition-all min-h-[44px] ${
                paymentType === 'integral'
                  ? 'border-[#119DA4] bg-[#119DA4]/5'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="text-xs font-medium text-[#26547C]">
                Paiement intégral (100%)
              </div>
              <div className="text-lg font-bold text-[#26547C] mt-0.5 tabular-nums">
                {formatFcfa(remainingAmount)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Aucun solde à régler au retrait
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Operator selector */}
      <div className="space-y-3">
        <span className="block text-sm font-semibold text-[#26547C]">
          1. Choisissez votre opérateur
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {activeMethods.map((m) => {
            const active = m.id === selectedMethod?.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedMethodId(m.id)}
                className={`px-4 py-3 rounded-2xl border-2 text-sm font-semibold transition-all min-h-[44px] flex items-center justify-center gap-2 ${
                  active
                    ? 'border-[#26547C] bg-[#26547C] text-white'
                    : 'border-slate-200 bg-[#EDF2F4]/60 text-[#26547C] hover:border-[#119DA4]'
                }`}
              >
                <CreditCard className="w-4 h-4 shrink-0" />
                <span className="truncate">{m.operatorName}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Operator Details */}
      {selectedMethod && (
        <div className="bg-[#EDF2F4] rounded-2xl p-5 space-y-3 border border-[#26547C]/15">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-slate-600">
                Bénéficiaire : <strong className="text-black">{selectedMethod.accountHolder}</strong>
              </div>
              <div className="text-xl font-bold text-[#26547C] tabular-nums mt-0.5">
                {selectedMethod.phoneNumber}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleCopy(selectedMethod.phoneNumber.replace(/\s+/g, ''), 'phone')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white text-[#26547C] text-xs font-semibold border border-slate-200 hover:border-[#119DA4] min-h-[44px]"
            >
              {copiedId === 'phone' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#2E9E6B]" />
                  Copié
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copier le numéro
                </>
              )}
            </button>
          </div>

          {selectedMethod.ussdCode && (
            <div className="text-xs bg-white/80 rounded-xl px-3.5 py-2 text-[#26547C] font-medium">
              Syntaxe rapide :{' '}
              <span className="font-mono">
                {selectedMethod.ussdCode.replace('MONTANT', String(amountToPay))}
              </span>
            </div>
          )}

          <p className="text-sm text-slate-700 leading-relaxed">
            {selectedMethod.instructions}
          </p>
        </div>
      )}

      {/* Proof Fields */}
      <div className="space-y-4">
        <span className="block text-sm font-semibold text-[#26547C]">
          2. Confirmez votre dépôt de {formatFcfa(amountToPay)}
        </span>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="deposit-phone"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Numéro utilisé pour le dépôt *
            </label>
            <input
              id="deposit-phone"
              type="tel"
              required
              value={depositPhone}
              onChange={(e) => setDepositPhone(e.target.value)}
              placeholder="+226 70 00 00 00"
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
            />
          </div>

          <div>
            <label
              htmlFor="tx-ref"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Référence de transaction (recommandé)
            </label>
            <input
              id="tx-ref"
              type="text"
              value={transactionRef}
              onChange={(e) => setTransactionRef(e.target.value)}
              placeholder="Ex : MP261118.1420.A9832"
              className="w-full px-4 py-3 rounded-2xl bg-[#EDF2F4] border border-transparent focus:border-[#119DA4] focus:bg-white focus:outline-none text-base min-h-[44px]"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Capture d’écran du SMS ou reçu Mobile Money *
          </label>
          <label className="flex flex-col items-center justify-center gap-2 p-6 rounded-2xl border-2 border-dashed border-[#119DA4]/50 bg-[#EDF2F4]/60 hover:bg-[#EDF2F4] cursor-pointer transition-colors text-center">
            <ImagePlus className="w-7 h-7 text-[#119DA4]" />
            <span className="text-sm font-semibold text-[#26547C]">
              {screenshotFile
                ? screenshotFile.name
                : 'Appuyez pour choisir votre capture d’écran'}
            </span>
            <span className="text-xs text-slate-500">
              Formats acceptés : JPG, PNG, PDF
            </span>
            <input
              type="file"
              accept="image/*,.pdf"
              className="sr-only"
              onChange={(e) => setScreenshotFile(e.target.files?.[0] || null)}
            />
          </label>
        </div>
      </div>

      {submitting && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-medium text-[#26547C]">
            <span>Envoi du justificatif...</span>
            <span className="tabular-nums">{uploadPercent}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
            <div
              className="h-full bg-[#119DA4] transition-all"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm font-medium text-[#EF233C] bg-[#EF233C]/10 px-4 py-3 rounded-2xl">
          {error}
        </p>
      )}

      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <ShieldCheck className="w-4 h-4 text-[#2E9E6B] shrink-0" />
          <span>Validation manuelle rapide par l’équipe FBC Print</span>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-full bg-[#EF233C] text-white font-semibold text-base hover:bg-[#d81b32] transition-colors min-h-[48px] disabled:opacity-60"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          Envoyer la preuve de paiement
        </button>
      </div>
    </form>
  );
};
