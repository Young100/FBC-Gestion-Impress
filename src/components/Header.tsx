import React from 'react';
import type { ClientAccountPublic } from '../types/fbc';

export type AppView = 'home' | 'order' | 'orders';

interface HeaderProps {
  currentView: AppView;
  clientAccount?: ClientAccountPublic | null;
  onNavigate: (view: AppView) => void;
  onStartOrder: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  clientAccount,
  onNavigate,
  onStartOrder,
}) => {
  const navItems: Array<{ id: AppView; label: string }> = [
    { id: 'home', label: 'Accueil' },
    { id: 'order', label: 'Commander' },
    { id: 'orders', label: 'Mes commandes' },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200/80">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-2 sm:gap-6">
        {/* Zone 1: Brand Logo */}
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="flex items-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#119DA4] rounded-xl p-1"
          aria-label="FBC Print Accueil"
        >
          <img
            src="/assets/aistudio/icone_c13161d0.svg"
            alt="FBC Print"
            className="h-8 w-8 sm:hidden object-contain"
          />
          <img
            src="/assets/aistudio/logo_horizontal_123c69c3.svg"
            alt="FBC Print"
            className="hidden sm:block h-11 w-auto object-contain"
          />
        </button>

        {/* Zone 2: Concise single-line navigation links */}
        <nav
          aria-label="Navigation principale"
          className="flex items-center gap-3 sm:gap-7 min-w-0 overflow-x-auto no-scrollbar"
        >
          {navItems.map((item) => {
            const active = currentView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`text-[13px] sm:text-base font-medium whitespace-nowrap shrink-0 py-2 border-b-2 transition-colors min-h-[44px] flex items-center gap-1.5 ${
                  active
                    ? 'text-[#26547C] border-[#119DA4]'
                    : 'text-slate-600 border-transparent hover:text-[#26547C]'
                }`}
              >
                {item.id === 'orders' && clientAccount && (
                  <span
                    className="w-2 h-2 rounded-full bg-[#2E9E6B] shrink-0"
                    aria-hidden="true"
                  />
                )}
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={onStartOrder}
            className="px-3.5 sm:px-6 py-2 sm:py-2.5 rounded-full bg-[#EF233C] text-white text-xs sm:text-sm font-semibold hover:bg-[#d81b32] active:scale-[0.98] transition-all whitespace-nowrap shrink-0 min-h-[40px] sm:min-h-[44px] shadow-sm"
          >
            <span className="sm:hidden">+ Commande</span>
            <span className="hidden sm:inline">Passer ma commande</span>
          </button>
        </div>
      </div>
    </header>
  );
};
