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

let sharedAudioCtx: AudioContext | null = null;
let audioUnlockBound = false;

function getOrCreateAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioCtx();
  }
  return sharedAudioCtx;
}

export function unlockNotificationAudio(): void {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

export function initAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (audioUnlockBound) return () => {};
  audioUnlockBound = true;

  const handleUnlock = () => {
    unlockNotificationAudio();
  };

  window.addEventListener('pointerdown', handleUnlock, { passive: true });
  window.addEventListener('keydown', handleUnlock, { passive: true });

  return () => {
    window.removeEventListener('pointerdown', handleUnlock);
    window.removeEventListener('keydown', handleUnlock);
    audioUnlockBound = false;
  };
}

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
  unlockNotificationAudio();
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
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime + 0.01;
    const tones: Array<{ freq: number; start: number; dur: number }> =
      variant === 'error'
        ? [
            { freq: 987.77, start: 0, dur: 0.13 },
            { freq: 739.99, start: 0.14, dur: 0.13 },
            { freq: 987.77, start: 0.28, dur: 0.22 },
          ]
        : variant === 'warning'
          ? [
              { freq: 783.99, start: 0, dur: 0.13 },
              { freq: 987.77, start: 0.14, dur: 0.2 },
            ]
          : variant === 'success'
            ? [
                { freq: 587.33, start: 0, dur: 0.11 },
                { freq: 880, start: 0.12, dur: 0.22 },
              ]
            : [
                { freq: 659.25, start: 0, dur: 0.11 },
                { freq: 880, start: 0.12, dur: 0.18 },
              ];

    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(tone.freq, now + tone.start);

      gain.gain.setValueAtTime(0.0001, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.2, now + tone.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.start);
      osc.stop(now + tone.start + tone.dur + 0.03);
    }
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

  // silent: false asks the browser/OS notification center to play its default notification sound
  const swNotifOptions: NotificationOptions & {
    renotify?: boolean;
    silent?: boolean;
    vibrate?: number[];
    data?: { url?: string };
  } = {
    body: options.body,
    icon: options.icon || '/pwa-192x192.png',
    badge: options.badge || options.icon || '/pwa-192x192.png',
    tag: options.tag,
    renotify: Boolean(options.tag),
    silent: false,
    vibrate: [220, 100, 220],
    requireInteraction: options.requireInteraction ?? false,
    data: { url: options.url },
  };

  // Prefer Service Worker showNotification (puts alert in OS/mobile notification tray with sound & vibration)
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      let matchedReg = options.swScope
        ? registrations.find((r) => {
            try {
              const path = new URL(r.scope).pathname;
              return path === options.swScope || path.startsWith(options.swScope!);
            } catch {
              return false;
            }
          })
        : registrations[0];

      if (!matchedReg) {
        matchedReg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<undefined>((resolve) =>
            window.setTimeout(() => resolve(undefined), 900)
          ),
        ]);
      }

      if (matchedReg && matchedReg.active) {
        await matchedReg.showNotification(options.title, swNotifOptions);
        return true;
      }
    } catch {
      // Fall through to window Notification constructor
    }
  }

  try {
    const notif = new Notification(options.title, {
      body: swNotifOptions.body,
      icon: swNotifOptions.icon,
      badge: swNotifOptions.badge,
      tag: swNotifOptions.tag,
      silent: false,
      requireInteraction: swNotifOptions.requireInteraction,
      data: swNotifOptions.data,
    });
    notif.onclick = () => {
      try {
        window.focus();
        if (
          options.url &&
          window.location.pathname + window.location.search !== options.url
        ) {
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
