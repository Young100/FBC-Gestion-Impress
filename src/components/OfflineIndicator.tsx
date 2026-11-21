import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-[#26547C] text-white border-b border-white/15 px-4 py-2.5 text-xs sm:text-sm font-medium"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-center gap-2 text-center">
        <WifiOff className="w-4 h-4 text-[#EF233C] shrink-0" />
        <span>
          Connexion internet interrompue — l’application reste affichée, mais l’envoi de
          fichiers et la synchronisation nécessitent du réseau.
        </span>
      </div>
    </div>
  );
};
