import React, { useState } from 'react';
import { Download, MonitorSmartphone, PlusSquare, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'hero' | 'compact' | 'footer';
  className?: string;
  appName?: string;
  iconSrc?: string;
  buttonLabel?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'hero',
  className = '',
  appName = 'FBC Print',
  iconSrc = '/pwa-192x192.png',
  buttonLabel,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  if (isInstalled) return null;
  // For hero and compact header variants, only show when native prompt is ready or on iOS Safari.
  // Footer variant remains accessible on desktop/mobile to provide direct install or browser instructions.
  if (variant !== 'footer' && !isInstallable && !isIOS) return null;

  const handleClick = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome === 'unavailable') {
        setShowGuideModal(true);
      }
      return;
    }
    setShowGuideModal(true);
  };

  return (
    <>
      {variant === 'compact' && (
        <button
          type="button"
          onClick={handleClick}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-[#119DA4]/15 text-[#26547C] hover:bg-[#119DA4] hover:text-white text-xs sm:text-sm font-semibold transition-colors min-h-[40px] whitespace-nowrap ${className}`}
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline">{buttonLabel || 'Installer l’app'}</span>
          <span className="sm:hidden">Installer</span>
        </button>
      )}

      {variant === 'hero' && (
        <button
          type="button"
          onClick={handleClick}
          className={`inline-flex items-center justify-center gap-2 px-5 py-4 rounded-full bg-white border border-slate-300 text-[#26547C] font-semibold text-base hover:border-[#26547C] hover:bg-slate-50 transition-colors min-h-[48px] ${className}`}
        >
          <Download className="w-4 h-4 text-[#119DA4] shrink-0" />
          {buttonLabel || 'Installer l’application'}
        </button>
      )}

      {variant === 'footer' && (
        <button
          type="button"
          onClick={handleClick}
          className={`inline-flex items-center gap-2 text-left text-sm font-medium text-[#26547C] hover:text-[#119DA4] transition-colors py-0.5 ${className}`}
        >
          <MonitorSmartphone className="w-4 h-4 text-[#119DA4] shrink-0" />
          {buttonLabel || 'Installer sur mobile & PC'}
        </button>
      )}

      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-guide-title"
          onClick={() => setShowGuideModal(false)}
        >
          <div
            className="bg-white rounded-3xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <img
                  src={iconSrc}
                  alt={appName}
                  className="w-11 h-11 rounded-2xl border border-slate-200 object-contain shrink-0"
                />
                <div>
                  <h3
                    id="pwa-install-guide-title"
                    className="font-display text-lg text-[#26547C]"
                  >
                    Installer {appName}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Accès direct depuis l’écran d’accueil ou le bureau
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                aria-label="Fermer"
                className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="space-y-3 text-sm text-slate-700 bg-[#EDF2F4] rounded-2xl p-4">
                <li className="flex items-start gap-2.5">
                  <Share className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
                  <span>
                    Appuyez sur le bouton <strong>Partager</strong> dans la barre de Safari.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <PlusSquare className="w-4 h-4 text-[#119DA4] shrink-0 mt-0.5" />
                  <span>
                    Faites défiler puis sélectionnez <strong>« Sur l’écran d’accueil »</strong>{' '}
                    et validez avec <strong>Ajouter</strong>.
                  </span>
                </li>
              </ol>
            ) : (
              <div className="space-y-3 text-sm text-slate-700 bg-[#EDF2F4] rounded-2xl p-4">
                <p>
                  <strong>Sur mobile Android (Chrome / Edge) :</strong> ouvrez le menu{' '}
                  <strong>⋮</strong> en haut à droite et appuyez sur{' '}
                  <strong>« Installer l’application »</strong>.
                </p>
                <p>
                  <strong>Sur PC (Windows / macOS / Linux) :</strong> dans Chrome ou Edge,
                  cliquez sur l’icône d’installation dans la barre d’adresse à droite, ou sur{' '}
                  <strong>Menu ⋮ → Caster, enregistrer et partager → Installer</strong>.
                </p>
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="px-5 py-2.5 rounded-full bg-[#26547C] text-white text-sm font-semibold hover:bg-[#1e4466] transition-colors min-h-[42px]"
              >
                Compris
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
