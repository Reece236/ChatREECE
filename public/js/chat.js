import { api, formatBody, timeLabel, dayLabel, relativeLabel } from './api.js';
import { mountBanner, permission, supported } from './notify.js';

const $ = (id) => document.getElementById(id);

// The widget opens /chat?embed=1, but signing in from inside the bubble lands
// on a plain /chat. Checking the frame covers both.
const embedded =
  new URLSearchParams(location.search).get('embed') === '1' || window.self !== window.top;
if (embedded) document.body.classList.add('embed');

const state = {
  ownerName: 'Reece',
  ownerOnline: false,
  conversations: [],
  activeId: null,
  messages: [],
  lastTyping: 0,
  typingTimer: null,
  baseTitle: 'Chat',
};

const LAST = 'chatreece:last';

// --- rendering -------------------------------------------------------------

function renderList() {
  const list = $('list');
  list.textContent = '';
  for (const c of state.conversations) {
    const item = document.createElement('button');
    item.className = 'item';
    item.type = 'button';
    if (c.id === state.activeId) item.setAttribute('aria-current', 'true');

    const title = document.createElement('div');
    title.className = 't';
    if (c.unread > 0 && c.id !== state.activeId) {
      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = String(c.unread);
      title.appendChild(badge);
    }
    title.append(c.title || 'New question');
    item.appendChild(title);

    if (c.preview) {
      const preview = document.createElement('div');
      preview.className = 'p';
      preview.textContent = c.preview;
      item.appendChild(preview);
    }

    const meta = document.createElement('div');
    meta.className = 'm';
    meta.textContent = relativeLabel(c.updated_at);
    item.appendChild(meta);

    item.addEventListener('click', () => {
      closeSide();
      open(c.id);
    });
    list.appendChild(item);
  }
}

function messageNode(m) {
  const row = document.createElement('div');
  row.className = `msg${m.role === 'user' ? ' mine' : ''}`;

  const from = document.createElement('div');
  from.className = 'from';
  from.textContent = `${m.role === 'user' ? 'You' : state.ownerName} · ${timeLabel(m.created_at)}`;

  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = formatBody(m.body);

  row.appendChild(from);
  row.appendChild(body);
  return row;
}

function renderStream() {
  const wrap = $('wrap');
  wrap.textContent = '';

  if (state.messages.length === 0) {
    const blank = document.createElement('div');
    blank.className = 'blank';
    const h = document.createElement('h2');
    h.textContent = `Ask ${state.ownerName} anything`;
    const p = document.createElement('p');
    p.textContent =
      'Your question goes to a real person, so an answer arrives when it arrives. Turn on notifications and you will be told when it does.';
    blank.appendChild(h);
    blank.appendChild(p);
    wrap.appendChild(blank);
    return;
  }

  let day = '';
  for (const m of state.messages) {
    const label = dayLabel(m.created_at);
    if (label !== day) {
      const sep = document.createElement('div');
      sep.className = 'day';
      sep.textContent = label;
      wrap.appendChild(sep);
      day = label;
    }
    wrap.appendChild(messageNode(m));
  }

  const last = state.messages[state.messages.length - 1];
  if (last.role === 'user') {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = state.ownerOnline
      ? `${state.ownerName} is online and will reply here.`
      : `Sent. ${state.ownerName} will reply here.`;
    wrap.appendChild(note);
  }

  toBottom();
}

function showTyping(on) {
  const existing = $('typing');
  if (!on) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const row = document.createElement('div');
  row.className = 'note';
  row.id = 'typing';
  row.textContent = `${state.ownerName} is typing…`;
  $('wrap').appendChild(row);
  toBottom();
}

function toBottom() {
  const stream = $('stream');
  requestAnimationFrame(() => {
    stream.scrollTop = stream.scrollHeight;
  });
}

function setStatus(online) {
  state.ownerOnline = online;
  $('status').textContent = online ? ` · ${state.ownerName} online` : '';
}

function updateBadge() {
  const unread = state.conversations.reduce(
    (n, c) => n + (c.id === state.activeId ? 0 : c.unread || 0),
    0,
  );
  document.title = unread ? `(${unread}) ${state.baseTitle}` : state.baseTitle;
}

// --- data ------------------------------------------------------------------

async function loadList() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations;
  renderList();
  updateBadge();
}

async function open(id) {
  state.activeId = id;
  localStorage.setItem(LAST, id);
  showTyping(false);
  const data = await api(`/api/conversations/${id}`);
  state.messages = data.messages;
  $('title').firstChild.textContent = data.conversation.title || 'Chat';
  const local = state.conversations.find((c) => c.id === id);
  if (local) local.unread = 0;
  renderList();
  renderStream();
  updateBadge();
}

async function startNew() {
  const data = await api('/api/conversations', { method: 'POST' });
  state.conversations.unshift(data.conversation);
  await open(data.conversation.id);
}

async function send(text) {
  if (!state.activeId) await startNew();

  const clientId = `c${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const optimistic = {
    id: `pending-${clientId}`,
    clientId,
    role: 'user',
    body: text,
    created_at: Date.now(),
  };
  state.messages.push(optimistic);
  renderStream();

  try {
    const data = await api(`/api/conversations/${state.activeId}/messages`, {
      method: 'POST',
      body: { body: text, clientId },
    });
    const i = state.messages.findIndex((m) => m.id === optimistic.id);
    if (i >= 0) state.messages[i] = { ...data.message, clientId };
    setStatus(Boolean(data.ownerOnline));
    $('title').firstChild.textContent = data.title;
    const local = state.conversations.find((c) => c.id === state.activeId);
    if (local) {
      local.title = data.title;
      local.preview = text.slice(0, 120);
      local.updated_at = data.message.created_at;
    }
    state.conversations.sort((a, b) => b.updated_at - a.updated_at);
    renderList();
    renderStream();
  } catch (err) {
    state.messages = state.messages.filter((m) => m.id !== optimistic.id);
    renderStream();
    const warn = document.createElement('p');
    warn.className = 'err';
    warn.textContent = err.message;
    $('wrap').appendChild(warn);
    $('input').value = text;
    grow();
    updateSend();
  }
}

// --- live ------------------------------------------------------------------

function seen(message) {
  return state.messages.some(
    (m) => m.id === message.id || (message.clientId && m.clientId === message.clientId),
  );
}

function connect() {
  const source = new EventSource('/api/events');

  source.addEventListener('presence', (event) => {
    const payload = JSON.parse(event.data);
    const changed = payload.ownerOnline !== state.ownerOnline;
    setStatus(payload.ownerOnline);
    if (changed) renderStream();
  });

  source.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    showTyping(false);

    if (payload.conversationId === state.activeId) {
      if (!seen(payload.message)) {
        state.messages.push(payload.message);
        renderStream();
      }
      api(`/api/conversations/${state.activeId}/read`, { method: 'POST' }).catch(() => {});
    } else {
      const local = state.conversations.find((c) => c.id === payload.conversationId);
      if (local) {
        if (payload.message.role === 'owner') local.unread = (local.unread || 0) + 1;
        local.preview = payload.message.body.slice(0, 120);
        local.updated_at = payload.message.created_at;
        state.conversations.sort((a, b) => b.updated_at - a.updated_at);
        renderList();
        updateBadge();
      } else {
        loadList().catch(() => {});
      }
    }
  });

  source.addEventListener('typing', (event) => {
    if (JSON.parse(event.data).conversationId !== state.activeId) return;
    showTyping(true);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => showTyping(false), 6000);
  });

  source.addEventListener('removed', (event) => {
    const { conversationId } = JSON.parse(event.data);
    state.conversations = state.conversations.filter((c) => c.id !== conversationId);
    if (conversationId === state.activeId) {
      state.activeId = null;
      state.messages = [];
      renderStream();
    }
    renderList();
  });

  source.onerror = () => setTimeout(() => loadList().catch(() => {}), 2500);
}

// --- composer --------------------------------------------------------------

function grow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function updateSend() {
  $('send').disabled = $('input').value.trim().length === 0;
}

function closeSide() {
  $('side').classList.remove('open');
  $('scrim').classList.add('hide');
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  grow();
  updateSend();
  await send(text);
});

$('input').addEventListener('input', () => {
  grow();
  updateSend();
  const now = Date.now();
  if (state.activeId && now - state.lastTyping > 3000) {
    state.lastTyping = now;
    api(`/api/conversations/${state.activeId}/typing`, { method: 'POST' }).catch(() => {});
  }
});

// Enter sends on a physical keyboard. On a touch keyboard it inserts a newline
// as people expect, and the Send button is right there.
$('input').addEventListener('keydown', (event) => {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touch) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('newChat').addEventListener('click', () => {
  closeSide();
  startNew().catch((err) => alert(err.message));
});

$('menu').addEventListener('click', () => {
  $('side').classList.add('open');
  $('scrim').classList.remove('hide');
});
$('scrim').addEventListener('click', closeSide);
$('closeSide').addEventListener('click', closeSide);

$('signOut').addEventListener('click', async () => {
  if (!confirm('Sign out on this device?')) return;
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem(LAST);
  location.replace('/?switch=1');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.activeId) return;
  api(`/api/conversations/${state.activeId}/read`, { method: 'POST' }).catch(() => {});
  loadList().catch(() => {});
});

// --- start -----------------------------------------------------------------

(async function start() {
  let me;
  try {
    me = await api('/api/me');
  } catch {
    location.replace('/');
    return;
  }

  state.ownerName = me.ownerName || 'Reece';
  state.baseTitle = `Chat with ${state.ownerName}`;
  document.title = state.baseTitle;
  $('who').textContent = me.user.username;
  $('input').placeholder = `Ask ${state.ownerName} a question`;
  setStatus(Boolean(me.ownerOnline));

  // Only offer notifications to someone who has not already got them.
  if (!me.pushEnabled || (supported() && permission() !== 'granted')) {
    mountBanner({
      bar: $('notifyBar'),
      button: $('notifyBtn'),
      text: $('notifyText'),
      subscribeUrl: '/api/push/subscribe',
      message: `Get notified when ${state.ownerName} replies.`,
      storageKey: 'chatreece:notify-asked',
    });
  }

  await loadList();

  const wanted = new URLSearchParams(location.search).get('c') || localStorage.getItem(LAST);
  const target = state.conversations.find((c) => c.id === wanted) || state.conversations[0];
  if (target) await open(target.id);
  else await startNew();

  connect();
  updateSend();
})();
