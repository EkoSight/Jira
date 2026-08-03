/**
 * Assignment alerts: a short chime plus a desktop notification.
 *
 * The chime is synthesised with the Web Audio API rather than shipped as an
 * audio file — no binary asset, no extra request, and it cannot be blocked by a
 * missing file on the server.
 */

const SOUND_KEY = 'taskflow.sound';
const SEEN_KEY = 'taskflow.lastNotificationId';

export const soundEnabled = () => localStorage.getItem(SOUND_KEY) !== 'off';
export const setSoundEnabled = (on) => localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');

export const lastSeenNotificationId = () => Number(localStorage.getItem(SEEN_KEY) || 0);
export const rememberNotificationId = (id) => localStorage.setItem(SEEN_KEY, String(id));

let audioContext = null;

/** Two soft notes — noticeable in an office without being irritating. */
export function playChime({ urgent = false } = {}) {
  if (!soundEnabled()) return;

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioContext = audioContext || new Ctx();
    // browsers suspend audio until the user has interacted with the page
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    const notes = urgent ? [880, 1046.5, 880] : [659.25, 880];

    notes.forEach((frequency, index) => {
      const start = now + index * 0.16;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);

      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.32);
    });
  } catch {
    /* audio is a nicety — never let it break the app */
  }
}

export const notificationPermission = () =>
  'Notification' in window ? Notification.permission : 'unsupported';

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

/** Desktop/mobile notification, falling back silently when not permitted. */
export function showDesktopNotification({ title, body, tag, onClick }) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const notification = new Notification(title, {
      body,
      tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    });
    if (onClick) {
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
    }
  } catch {
    /* not supported in this context (e.g. some in-app browsers) */
  }
}

const URGENT_TYPES = new Set(['assigned', 'blackmark']);

/** Announces anything that arrived since the last poll. */
export function announce(notifications, { onOpen } = {}) {
  const lastSeen = lastSeenNotificationId();
  const fresh = notifications.filter((n) => n.id > lastSeen && !n.is_read);
  if (!fresh.length) return fresh;

  const newest = fresh[0];
  rememberNotificationId(Math.max(...notifications.map((n) => n.id)));

  playChime({ urgent: fresh.some((n) => URGENT_TYPES.has(n.type)) });
  showDesktopNotification({
    title: fresh.length === 1 ? newest.title : `${fresh.length} new updates`,
    body: fresh.length === 1 ? newest.body || '' : fresh.map((n) => n.title).join('\n'),
    tag: `taskflow-${newest.id}`,
    onClick: () => onOpen?.(newest),
  });

  return fresh;
}

/** First run: remember what already exists so old items do not all chime at once. */
export function primeNotificationBaseline(notifications) {
  if (localStorage.getItem(SEEN_KEY) !== null) return;
  const highest = notifications.length ? Math.max(...notifications.map((n) => n.id)) : 0;
  rememberNotificationId(highest);
}
