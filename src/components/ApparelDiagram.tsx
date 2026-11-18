import React from 'react';
import type { ApparelDisposition, ApparelType } from '../types/fbc';

interface ApparelDiagramProps {
  article: ApparelType;
  disposition: ApparelDisposition;
}

export const ApparelDiagram: React.FC<ApparelDiagramProps> = ({
  article,
  disposition,
}) => {
  const showLeft =
    disposition === 'poitrine_gauche' ||
    disposition === 'deux_poitrines' ||
    disposition === 'poitrine_dos' ||
    disposition === 'deux_poitrines_dos';
  const showRight =
    disposition === 'poitrine_droite' ||
    disposition === 'deux_poitrines' ||
    disposition === 'deux_poitrines_dos';
  const showBack =
    disposition === 'poitrine_dos' || disposition === 'deux_poitrines_dos';

  if (article === 'casquette') {
    return (
      <div className="bg-[#EDF2F4] rounded-2xl p-4 flex flex-col items-center justify-center gap-2 border border-[#26547C]/15">
        <svg viewBox="0 0 180 110" className="w-40 h-24">
          <path
            d="M35 65 C35 32, 62 18, 90 18 C118 18, 145 32, 145 65 L162 76 C135 84, 65 84, 35 65 Z"
            fill="#ffffff"
            stroke="#26547C"
            strokeWidth="3"
          />
          <rect x="72" y="34" width="36" height="22" rx="4" fill="#119DA4" fillOpacity="0.22" stroke="#119DA4" strokeWidth="2" />
          <text x="90" y="48" textAnchor="middle" fontSize="9" fill="#26547C" fontWeight="700">
            FACE
          </text>
        </svg>
        <p className="text-xs text-slate-600 text-center">
          Emplacement principal sur casquette · fichier séparé requis
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[#EDF2F4] rounded-2xl p-4 grid grid-cols-2 gap-4 border border-[#26547C]/15">
      {/* Front view */}
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-xs font-semibold text-[#26547C]">Face avant</span>
        <svg viewBox="0 0 140 130" className="w-28 h-24">
          <path
            d="M42 18 L58 24 Q70 30 82 24 L98 18 L124 34 L112 58 L100 52 L100 118 L40 118 L40 52 L28 58 L16 34 Z"
            fill="#ffffff"
            stroke="#26547C"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {article === 'polo' && (
            <path d="M58 24 L70 42 L82 24" fill="none" stroke="#26547C" strokeWidth="2" />
          )}
          {/* Left chest (viewer's right) */}
          <rect
            x="76"
            y="45"
            width="18"
            height="16"
            rx="3"
            fill={showLeft ? '#119DA4' : '#E2E8F0'}
            fillOpacity={showLeft ? 0.35 : 0.6}
            stroke={showLeft ? '#119DA4' : '#94A3B8'}
            strokeWidth="1.8"
          />
          {/* Right chest (viewer's left) */}
          <rect
            x="46"
            y="45"
            width="18"
            height="16"
            rx="3"
            fill={showRight ? '#EF233C' : '#E2E8F0'}
            fillOpacity={showRight ? 0.25 : 0.6}
            stroke={showRight ? '#EF233C' : '#94A3B8'}
            strokeWidth="1.8"
          />
        </svg>
        <span className="text-xs text-slate-600">
          {showLeft && showRight ? '2 poitrines' : showLeft ? 'Poitrine gauche' : 'Poitrine droite'}
        </span>
      </div>

      {/* Back view */}
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-xs font-semibold text-[#26547C]">Dos</span>
        <svg viewBox="0 0 140 130" className="w-28 h-24">
          <path
            d="M42 18 L58 21 Q70 24 82 21 L98 18 L124 34 L112 58 L100 52 L100 118 L40 118 L40 52 L28 58 L16 34 Z"
            fill="#ffffff"
            stroke="#26547C"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <rect
            x="49"
            y="38"
            width="42"
            height="46"
            rx="5"
            fill={showBack ? '#119DA4' : '#E2E8F0'}
            fillOpacity={showBack ? 0.28 : 0.4}
            stroke={showBack ? '#119DA4' : '#CBD5E1'}
            strokeWidth="2"
            strokeDasharray={showBack ? undefined : '4 3'}
          />
          {showBack && (
            <text x="70" y="64" textAnchor="middle" fontSize="10" fill="#26547C" fontWeight="700">
              DOS
            </text>
          )}
        </svg>
        <span className="text-xs text-slate-600">{showBack ? 'Dos inclus' : 'Sans dos'}</span>
      </div>
    </div>
  );
};
