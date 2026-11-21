import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BellRing,
  CheckCircle2,
  X,
} from 'lucide-react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  id?: string;
  title: string;
  message: string;
  badge?: string;
  variant?: ToastVariant;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ActiveToast extends ToastInput {
  id: string;
  variant: ToastVariant;
  durationMs: number;
  createdAt: number;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<
  ToastVariant,
  {
    border: string;
    iconBg: string;
    iconColor: string;
    bar: string;
    badgeBg: string;
    Icon: React.ComponentType<{ className?: string }>;
  }
> = {
  success: {
    border: 'border-[#2E9E6B]/30',
    iconBg: 'bg-[#2E9E6B]/12',
    iconColor: 'text-[#2E9E6B]',
    bar: 'bg-[#2E9E6B]',
    badgeBg: 'bg-[#2E9E6B]/10 text-[#237A52]',
    Icon: CheckCircle2,
  },
  info: {
    border: 'border-[#119DA4]/30',
    iconBg: 'bg-[#119DA4]/12',
    iconColor: 'text-[#119DA4]',
    bar: 'bg-[#119DA4]',
    badgeBg: 'bg-[#26547C]/10 text-[#26547C]',
    Icon: BellRing,
  },
  warning: {
    border: 'border-amber-300',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-600',
    bar: 'bg-amber-500',
    badgeBg: 'bg-amber-100 text-amber-800',
    Icon: AlertTriangle,
  },
  error: {
    border: 'border-[#EF233C]/35',
    iconBg: 'bg-[#EF233C]/12',
    iconColor: 'text-[#EF233C]',
    bar: 'bg-[#EF233C]',
    badgeBg: 'bg-[#EF233C]/10 text-[#EF233C]',
    Icon: AlertCircle,
  },
};

const MAX_VISIBLE_TOASTS = 4;

interface ToastCardProps {
  toast: ActiveToast;
  onDismiss: (id: string) => void;
}

const ToastCard: React.FC<ToastCardProps> = ({ toast, onDismiss }) => {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef<number>(toast.durationMs);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (toast.durationMs <= 0 || paused) return;
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, remainingRef.current);

    return () => {
      window.clearTimeout(timer);
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    };
  }, [toast.id, toast.durationMs, paused, onDismiss]);

  const style = VARIANT_STYLES[toast.variant];
  const Icon = style.Icon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      className={`pointer-events-auto relative overflow-hidden bg-white/95 backdrop-blur-md rounded-2xl border ${style.border} shadow-lg p-4`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-xl ${style.iconBg} ${style.iconColor} flex items-center justify-center shrink-0 mt-0.5`}
        >
          <Icon className="w-5 h-5" />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              {toast.badge && (
                <span
                  className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-bold font-mono ${style.badgeBg}`}
                >
                  {toast.badge}
                </span>
              )}
              <h4 className="text-sm font-bold text-[#26547C] leading-snug">
                {toast.title}
              </h4>
            </div>

            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Fermer la notification"
              className="p-1.5 -mr-1.5 -mt-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs sm:text-sm text-slate-700 leading-relaxed break-words">
            {toast.message}
          </p>

          {toast.actionLabel && toast.onAction && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => {
                  toast.onAction?.();
                  onDismiss(toast.id);
                }}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-[#26547C] hover:text-[#119DA4] transition-colors py-1"
              >
                {toast.actionLabel}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {toast.durationMs > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-100">
          <motion.div
            initial={{ scaleX: 1 }}
            animate={{ scaleX: paused ? undefined : 0 }}
            transition={{ duration: toast.durationMs / 1000, ease: 'linear' }}
            style={{ transformOrigin: 'left center' }}
            className={`h-full ${style.bar}`}
          />
        </div>
      )}
    </motion.div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const showToast = useCallback((input: ToastInput): string => {
    const id =
      input.id || `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nextToast: ActiveToast = {
      ...input,
      id,
      variant: input.variant ?? 'info',
      durationMs: input.durationMs ?? 8000,
      createdAt: Date.now(),
    };

    setToasts((prev) => {
      const withoutDuplicate = prev.filter((t) => t.id !== id);
      const updated = [nextToast, ...withoutDuplicate];
      return updated.slice(0, MAX_VISIBLE_TOASTS);
    });

    return id;
  }, []);

  const value = useMemo(
    () => ({ showToast, dismissToast, clearToasts }),
    [showToast, dismissToast, clearToasts]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-label="Notifications en temps réel"
        className="pointer-events-none fixed z-50 top-20 inset-x-3 sm:inset-x-auto sm:right-6 sm:w-[390px] flex flex-col gap-2.5"
      >
        <AnimatePresence mode="popLayout">
          {toasts.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
