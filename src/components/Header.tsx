import React, { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ChevronRight } from 'lucide-react';
import type { ClientAccountPublic, ServerNotificationItem } from '../types/fbc';

export type AppView = 'home' | 'order' | 'orders';

interface HeaderProps {
  currentView: AppView;
  clientAccount?: ClientAccountPublic | null;
  notifications?: ServerNotificationItem[];
  unreadCount?: number;
  onNavigate: (view: AppView) => void;
  onStartOrder: () => void;
  onOpenNotification?: (notif: ServerNotificationItem) => void;
  onMarkAllRead?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  clientAccount,
  notifications = [],
  unreadCount = 0,
  onNavigate,
  onStartOrder,
  onOpenNotification,
  onMarkAllRead,
}) => {
  const [notifOpen, setNotifOpen] = useState(false);
  const notifBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!notifOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (notifBoxRef.current && !notifBoxRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotifOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [notifOpen]);

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

        {/* Zone 3: Notification Center Bell (when logged in) + Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          {clientAccount && (
            <div ref={notifBoxRef} className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((v) => !v)}
                aria-label="Centre de notifications"
                aria-expanded={notifOpen}
                className="relative p-2 rounded-full bg-[#EDF2F4] text-[#26547C] hover:bg-[#119DA4]/15 transition-colors min-h-[40px] min-w-[40px] sm:min-h-[44px] sm:min-w-[44px] flex items-center justify-center"
              >
                <Bell className="w-4 h-4 sm:w-5 sm:h-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#EF233C] text-white text-[10px] font-bold flex items-center justify-center tabular-nums shadow-sm">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="fixed sm:absolute left-3 right-3 sm:left-auto sm:right-0 top-[4.25rem] sm:top-13 z-50 sm:w-96 bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
                  <div className="px-4 py-3.5 border-b border-slate-100 flex items-center justify-between gap-2 bg-[#EDF2F4]/60">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-[#26547C]">
                        Centre de notifications
                      </span>
                      {unreadCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-[#EF233C] text-white text-[10px] font-bold tabular-nums">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                    {unreadCount > 0 && onMarkAllRead && (
                      <button
                        type="button"
                        onClick={() => onMarkAllRead()}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-[#119DA4] hover:underline"
                      >
                        <CheckCheck className="w-3.5 h-3.5" />
                        Tout lire
                      </button>
                    )}
                  </div>

                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                    {notifications.length === 0 ? (
                      <div className="px-5 py-8 text-center space-y-1.5">
                        <p className="text-sm font-semibold text-[#26547C]">
                          Aucune notification pour le moment
                        </p>
                        <p className="text-xs text-slate-500">
                          Vos alertes de suivi (paiement, production, retrait) apparaîtront ici et sur votre appareil.
                        </p>
                      </div>
                    ) : (
                      notifications.map((n) => {
                        const dotColor =
                          n.variant === 'error'
                            ? 'bg-[#EF233C]'
                            : n.variant === 'warning'
                              ? 'bg-amber-500'
                              : n.variant === 'success'
                                ? 'bg-[#2E9E6B]'
                                : 'bg-[#119DA4]';
                        return (
                          <button
                            key={n.notifId}
                            type="button"
                            onClick={() => {
                              setNotifOpen(false);
                              onOpenNotification?.(n);
                            }}
                            className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-colors hover:bg-[#EDF2F4]/70 ${
                              !n.read ? 'bg-[#119DA4]/[0.05]' : ''
                            }`}
                          >
                            <span
                              className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                                !n.read ? dotColor : 'bg-slate-300'
                              }`}
                            />
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={`text-xs font-bold truncate ${
                                    !n.read ? 'text-[#26547C]' : 'text-slate-700'
                                  }`}
                                >
                                  {n.title}
                                </span>
                                <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
                                  {new Date(n.createdAt).toLocaleTimeString('fr-FR', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </div>
                              <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                                {n.body}
                              </p>
                            </div>
                            {n.trackingCode && (
                              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 mt-1" />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

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
