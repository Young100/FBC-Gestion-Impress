import React from 'react';
import { BellRing, Volume2, X } from 'lucide-react';
import type { BrowserNotifPermission } from '../lib/browserNotifications';

interface NotificationPermissionPromptProps {
  mode: 'atelier' | 'client';
  permission: BrowserNotifPermission;
  dismissed: boolean;
  onEnable: () => void;
  onDismiss: () => void;
}

export const NotificationPermissionPrompt: React.FC<
  NotificationPermissionPromptProps
> = ({ mode, permission, dismissed, onEnable, onDismiss }) => {
  if (permission !== 'default' || dismissed) {
    return null;
  }

  const isAtelier = mode === 'atelier';

  return (
    <div
      role="region"
      aria-label="Autorisation des notifications sonores"
      className="bg-gradient-to-r from-[#26547C] to-[#119DA4] text-white rounded-3xl p-4 sm:p-5 shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-4"
    >
      <div className="flex items-start gap-3.5 min-w-0">
        <div className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
          <BellRing className="w-5 h-5 text-white" />
        </div>
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-sm sm:text-base leading-snug">
              Autoriser les notifications sonores
            </h3>
            <Volume2 className="w-4 h-4 text-white/85 shrink-0" />
          </div>
          <p className="text-xs sm:text-sm text-white/90 leading-relaxed">
            {isAtelier
              ? 'Recevez une alerte sonore directement dans vos notifications (téléphone & PC) à chaque nouvelle commande, paiement à vérifier ou fichier corrigé.'
              : 'Recevez une alerte sonore dans vos notifications (téléphone & PC) dès que votre paiement est validé, que l’impression démarre ou que votre commande est prête.'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
        <button
          type="button"
          onClick={onEnable}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#26547C] text-xs sm:text-sm font-bold hover:bg-[#EDF2F4] transition-colors shadow-sm min-h-[44px]"
        >
          <BellRing className="w-4 h-4 text-[#119DA4]" />
          Autoriser maintenant
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Plus tard"
          title="Plus tard"
          className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
