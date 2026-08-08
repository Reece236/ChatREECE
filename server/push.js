'use strict';

// Web push for both sides: visitors get told when their question is answered,
// the owner gets told when a question arrives.
//
// VAPID keys are generated once and kept in the settings table, so they live on
// the same persistent disk as everything else. Regenerating them would silently
// invalidate every existing subscription, so they are only ever created when
// absent.

const webpush = require('web-push');
const store = require('./db');

const CONTACT = process.env.PUSH_CONTACT || 'mailto:owner@example.com';

let publicKey = store.getSetting('vapid_public');
let privateKey = store.getSetting('vapid_private');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  publicKey = process.env.VAPID_PUBLIC_KEY;
  privateKey = process.env.VAPID_PRIVATE_KEY;
} else if (!publicKey || !privateKey) {
  const generated = webpush.generateVAPIDKeys();
  publicKey = generated.publicKey;
  privateKey = generated.privateKey;
  store.setSetting('vapid_public', publicKey);
  store.setSetting('vapid_private', privateKey);
}

webpush.setVapidDetails(CONTACT, publicKey, privateKey);

function toWebPushSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

async function deliver(rows, payload) {
  if (rows.length === 0) return;
  const body = JSON.stringify(payload);

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(toWebPushSubscription(row), body, { TTL: 86400 });
      } catch (err) {
        // 404/410 mean the browser threw the subscription away — the user
        // cleared site data, uninstalled the PWA, or revoked permission.
        // Keeping those rows would mean retrying forever.
        if (err.statusCode === 404 || err.statusCode === 410) {
          store.deletePushSubscription(row.endpoint);
        } else {
          console.warn('[push] delivery failed:', err.statusCode || err.message);
        }
      }
    }),
  );
}

/** Tells one visitor that their question got an answer. */
function notifyUser(userId, { title, body, conversationId }) {
  const rows = store.pushSubscriptionsForUser(userId);
  return deliver(rows, { title, body, url: `/chat?c=${conversationId}`, tag: conversationId });
}

/** Tells the owner's devices that a question came in. */
function notifyOwner({ title, body, conversationId }) {
  const rows = store.pushSubscriptionsForOwner();
  return deliver(rows, {
    title,
    body,
    url: `/admin?c=${conversationId}`,
    tag: `owner-${conversationId}`,
  });
}

module.exports = { publicKey, notifyUser, notifyOwner };
