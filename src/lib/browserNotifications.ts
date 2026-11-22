export type BrowserNotifPermission = NotificationPermission | 'unsupported';

const CLIENT_PREF_KEY = 'fbc_client_browser_notifs';
const ATELIER_PREF_KEY = 'fbc_atelier_browser_notifs';
const ATELIER_SOUND_KEY = 'fbc_atelier_sound_enabled';
const CLIENT_SOUND_KEY = 'fbc_client_sound_enabled';

export {
  ATELIER_PREF_KEY,
  ATELIER_SOUND_KEY,
  CLIENT_PREF_KEY,
  CLIENT_SOUND_KEY,
};

export function getBrowserNotifPermission(): BrowserNotifPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export function isBrowserNotifEnabled(storageKey: string): boolean {
  if (getBrowserNotifPermission() !== 'granted') return false;
  try {
    const val = window.localStorage.getItem(storageKey);
    // If permission was already granted previously and user didn't explicitly turn off, allow it
    return val !== 'false';
  } catch {
    return true;
  }
}

export function setBrowserNotifEnabled(storageKey: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey, enabled ? 'true' : 'false');
  } catch {
    // Ignore private-mode storage errors
  }
}

export function isAudioChimeEnabled(storageKey: string): boolean {
  try {
    const val = window.localStorage.getItem(storageKey);
    return val !== 'false';
  } catch {
    return true;
  }
}

export function setAudioChimeEnabled(storageKey: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage errors
  }
}

export async function requestBrowserNotifPermission(
  storageKey: string
): Promise<BrowserNotifPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }

  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      setBrowserNotifEnabled(storageKey, true);
    } else if (result === 'denied') {
      setBrowserNotifEnabled(storageKey, false);
    }
    return result;
  } catch {
    return Notification.permission;
  }
}

export function playNotificationChime(
  variant: 'info' | 'success' | 'warning' | 'error' = 'info'
): void {
  if (typeof window === 'undefined') return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const tones: Array<{ freq: number; start: number; dur: number }> =
      variant === 'error'
        ? [
            { freq: 880, start: 0, dur: 0.11 },
            { freq: 660, start: 0.12, dur: 0.11 },
            { freq: 880, start: 0.24, dur: 0.16 },
          ]
        : variant === 'warning'
          ? [
              { freq: 740, start: 0, dur: 0.12 },
              { freq: 880, start: 0.13, dur: 0.16 },
            ]
          : variant === 'success'
            ? [
                { freq: 587.33, start: 0, dur: 0.1 },
                { freq: 880, start: 0.11, dur: 0.18 },
              ]
            : [
                { freq: 659.25, start: 0, dur: 0.09 },
                { freq: 783.99, start: 0.1, dur: 0.14 },
              ];

    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone.freq, now + tone.start);

      gain.gain.setValueAtTime(0.0001, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.08, now + tone.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.start);
      osc.stop(now + tone.start + tone.dur + 0.02);
    }

    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 800);
  } catch {
    // Autoplay policy may block WebAudio until user interacts; safe to ignore
  }
}

export interface NativePopupOptions {
  title: string;
  body: string;
  tag?: string;
  icon?: string;
  badge?: string;
  url?: string;
  swScope?: string;
  requireInteraction?: boolean;
}

export async function dispatchNativeNotification(
  options: NativePopupOptions
): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  const notifOptions: NotificationOptions & {
    renotify?: boolean;
    data?: { url?: string };
  } = {
    body: options.body,
    icon: options.icon || '/pwa-192x192.png',
    badge: options.badge || options.icon || '/pwa-192x192.png',
    tag: options.tag,
    renotify: Boolean(options.tag),
    requireInteraction: options.requireInteraction ?? false,
    data: { url: options.url },
  };

  // Prefer Service Worker showNotification when available (required on Android Chrome)
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const matchedReg = options.swScope
        ? registrations.find((r) => {
            try {
              const path = new URL(r.scope).pathname;
              return path === options.swScope || path.startsWith(options.swScope!);
            } catch {
              return false;
            }
          })
        : registrations[0];

      if (matchedReg && matchedReg.active) {
        await matchedReg.showNotification(options.title, notifOptions);
        return true;
      }
    } catch {
      // Fall through to window Notification constructor
    }
  }

  try {
    const notif = new Notification(options.title, notifOptions);
    notif.onclick = () => {
      try {
        window.focus();
        if (options.url && window.location.pathname + window.location.search !== options.url) {
          window.location.assign(options.url);
        }
      } catch {
        // Ignore window focus issues
      }
      notif.close();
    };
    return true;
  } catch {
    return false;
  }
}
