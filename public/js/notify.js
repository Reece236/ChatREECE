import { api } from './api.js';

// Turning on notifications, from the browser's side.
//
// The permission prompt must come from a real tap. Asking on page load gets
// the request denied permanently by some browsers and annoys everyone else, so
// nothing here runs until a button is pressed.

export function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function permission() {
  return supported() ? Notification.permission : 'unsupported';
}

/**
 * iOS only allows web push once the site has been added to the Home Screen,
 * and gives no way to trigger that from a page. Detecting it lets us show
 * instructions instead of a button that cannot work.
 */
export function needsHomeScreenInstall() {
  const iOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  return iOS && !standalone;
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Registers the worker, asks permission, subscribes, and hands the
 * subscription to the server. Returns a short reason string on failure so the
 * caller can say something useful rather than "something went wrong".
 */
export async function enable(subscribeUrl) {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  if (needsHomeScreenInstall()) return { ok: false, reason: 'ios-install' };

  const result = await Notification.requestPermission();
  if (result !== 'granted') return { ok: false, reason: result };

  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  // Reuse an existing subscription if there is one; re-subscribing with a
  // different key silently breaks delivery.
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const { publicKey } = await api('/api/push/key');
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await api(subscribeUrl, { method: 'POST', body: subscription.toJSON() });
  return { ok: true };
}

export async function disable() {
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration && (await registration.pushManager.getSubscription());
  if (!subscription) return;
  await api('/api/push/unsubscribe', {
    method: 'POST',
    body: { endpoint: subscription.endpoint },
  }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

export function explain(reason) {
  switch (reason) {
    case 'denied':
      return 'Notifications are blocked for this site. Turn them back on in your browser settings.';
    case 'ios-install':
      return 'On iPhone, tap Share then "Add to Home Screen" first, then open it from there.';
    case 'unsupported':
      return 'This browser cannot do notifications.';
    default:
      return 'Notifications were not turned on.';
  }
}

/**
 * Wires up a "get notified" bar. Hides itself when it cannot help — already
 * granted, unsupported browser, or previously dismissed.
 */
export function mountBanner({ bar, button, text, subscribeUrl, message, storageKey }) {
  if (!bar) return;

  const dismissed = localStorage.getItem(storageKey) === '1';
  if (!supported() || permission() === 'granted' || dismissed) {
    bar.classList.add('hide');
    return;
  }
  if (permission() === 'denied') {
    bar.classList.add('hide');
    return;
  }

  text.textContent = message;
  bar.classList.remove('hide');

  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await enable(subscribeUrl).catch((err) => ({ ok: false, reason: err.message }));
    if (result.ok) {
      bar.classList.add('hide');
      localStorage.setItem(storageKey, '1');
    } else {
      text.textContent = explain(result.reason);
      button.disabled = false;
      button.textContent = 'Try again';
    }
  });
}
