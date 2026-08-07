'use strict';

// A very small server-sent-events hub. Visitors subscribe to their own user id;
// the owner subscribes to the "owner" channel. Everything a browser needs to
// stay live — new replies, typing dots, read receipts — goes through here.

const HEARTBEAT_MS = 25_000;

const channels = new Map(); // channel -> Set<res>

function subscribe(channel, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stops nginx from buffering the stream into uselessness.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(res);

  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  function cleanup() {
    clearInterval(beat);
    const current = channels.get(channel);
    if (current) {
      current.delete(res);
      if (current.size === 0) channels.delete(channel);
    }
  }

  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

function publish(channel, event, data) {
  const set = channels.get(channel);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...set]) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

function hasListeners(channel) {
  const set = channels.get(channel);
  return Boolean(set && set.size > 0);
}

/** Sends to every connected visitor — used for owner presence. */
function broadcastToVisitors(event, data) {
  for (const channel of channels.keys()) {
    if (channel.startsWith('user:')) publish(channel, event, data);
  }
}

module.exports = {
  subscribe,
  publish,
  hasListeners,
  broadcastToVisitors,
  OWNER_CHANNEL: 'owner',
};
