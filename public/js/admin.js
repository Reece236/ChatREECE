import { api, formatBody, timeLabel, dayLabel, relativeLabel } from './api.js';
import { mountBanner, permission, supported } from './notify.js';

const $ = (id) => document.getElementById(id);

const state = {
  ownerName: 'Reece',
  conversations: [],
  activeId: null,
  person: null,
  messages: [],
  waitingOnly: false,
  lastTyping: 0,
  sent: new Set(),
};

function note(el, message, bad) {
  el.textContent = message || '';
  el.className = bad ? 'err' : 'ok';
  el.classList.toggle('hide', !message);
}

// --- gate ------------------------------------------------------------------

$('gateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  note($('gateErr'), '', true);
  try {
    await api('/api/auth/owner', { method: 'POST', body: { key: $('gateKey').value } });
    location.reload();
  } catch (err) {
    note($('gateErr'), err.message, true);
  }
});

// --- inbox -----------------------------------------------------------------

function visible() {
  return state.waitingOnly ? state.conversations.filter((c) => c.unread > 0) : state.conversations;
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  const rows = visible();

  if (rows.length === 0) {
    const blank = document.createElement('div');
    blank.className = 'blank tight';
    blank.textContent = state.waitingOnly ? 'Nothing waiting.' : 'No questions yet.';
    list.appendChild(blank);
  }

  for (const c of rows) {
    const item = document.createElement('button');
    item.className = 'item';
    item.type = 'button';
    if (c.id === state.activeId) item.setAttribute('aria-current', 'true');

    const title = document.createElement('div');
    title.className = 't';
    if (c.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = String(c.unread);
      title.appendChild(badge);
    }
    title.append(c.username || 'Someone');
    item.appendChild(title);

    const preview = document.createElement('div');
    preview.className = 'p';
    preview.textContent = `${c.last_role === 'owner' ? 'You: ' : ''}${c.last_body || c.title || ''}`;
    item.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'm';
    meta.textContent = relativeLabel(c.updated_at);
    if (c.blocked) meta.textContent += ' · blocked';
    else if (c.last_role === 'user') meta.textContent += ' · needs a reply';
    item.appendChild(meta);

    item.addEventListener('click', () => {
      closePanels();
      open(c.id);
    });
    list.appendChild(item);
  }

  const unread = state.conversations.reduce((n, c) => n + (c.unread || 0), 0);
  $('stats').textContent = unread ? `${unread} waiting` : `${state.conversations.length} total`;
  document.title = unread ? `(${unread}) Answering desk` : 'Answering desk';
}

async function loadInbox() {
  const data = await api('/api/owner/inbox');
  state.conversations = data.conversations;
  renderList();
}

// --- conversation ----------------------------------------------------------

function messageNode(m) {
  // The owner sits where a bot's answer would sit; the visitor's own messages
  // stay on the right, same as they see it.
  const row = document.createElement('div');
  row.className = `msg${m.role === 'user' ? ' mine' : ''}`;

  const from = document.createElement('div');
  from.className = 'from';
  const who = m.role === 'user' ? state.person?.username || 'Them' : 'You';
  from.textContent = `${who} · ${timeLabel(m.created_at)}`;

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

  if (!state.activeId) {
    const blank = document.createElement('div');
    blank.className = 'blank';
    const h = document.createElement('h2');
    h.textContent = 'Your answering desk';
    const p = document.createElement('p');
    p.textContent =
      'Questions from your site arrive in the list. Open one and reply whenever you like.';
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

  const stream = $('stream');
  requestAnimationFrame(() => {
    stream.scrollTop = stream.scrollHeight;
  });
}

async function open(id) {
  state.activeId = id;
  const data = await api(`/api/owner/conversations/${id}`);
  state.messages = data.messages;
  state.person = data.user;

  $('title').firstChild.textContent = data.user?.username || 'Conversation';
  $('sub').textContent = ` · ${data.conversation.title || ''}`.slice(0, 60);
  $('panelWho').textContent = data.user?.username || 'this person';
  $('note').value = data.user?.note || '';
  $('block').textContent = data.user?.blocked ? 'Unblock' : 'Block';

  const local = state.conversations.find((c) => c.id === id);
  if (local) local.unread = 0;
  renderList();
  renderStream();
  $('send').disabled = $('input').value.trim().length === 0;
}

async function reply(text) {
  const clientId = `o${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.sent.add(clientId);
  const optimistic = {
    id: `pending-${clientId}`,
    clientId,
    role: 'owner',
    body: text,
    created_at: Date.now(),
  };
  state.messages.push(optimistic);
  renderStream();

  try {
    const data = await api(`/api/owner/conversations/${state.activeId}/messages`, {
      method: 'POST',
      body: { body: text, clientId },
    });
    const i = state.messages.findIndex((m) => m.id === optimistic.id);
    if (i >= 0) state.messages[i] = { ...data.message, clientId };
    const local = state.conversations.find((c) => c.id === state.activeId);
    if (local) {
      local.last_body = text.slice(0, 120);
      local.last_role = 'owner';
      local.updated_at = data.message.created_at;
      local.unread = 0;
    }
    state.conversations.sort((a, b) => b.updated_at - a.updated_at);
    renderList();
    renderStream();
  } catch (err) {
    state.messages = state.messages.filter((m) => m.id !== optimistic.id);
    renderStream();
    alert(err.message);
    $('input').value = text;
  }
}

// --- live ------------------------------------------------------------------

function connect() {
  const source = new EventSource('/api/owner/events');

  source.addEventListener('message', (event) => {
    const { conversationId, message } = JSON.parse(event.data);
    // Our own reply, already on screen. Replies from another desk tab are not,
    // so match on the id we generated rather than on the role.
    if (message.clientId && state.sent.has(message.clientId)) return;

    if (conversationId === state.activeId) {
      if (!state.messages.some((m) => m.id === message.id)) {
        state.messages.push(message);
        renderStream();
      }
      if (message.role === 'user') {
        api(`/api/owner/conversations/${state.activeId}/read`, { method: 'POST' }).catch(() => {});
      }
      const local = state.conversations.find((c) => c.id === state.activeId);
      if (local) {
        local.last_body = message.body.slice(0, 120);
        local.last_role = message.role;
        local.updated_at = message.created_at;
      }
      renderList();
    } else {
      loadInbox().catch(() => {});
    }
  });

  source.addEventListener('removed', () => loadInbox().catch(() => {}));
  source.onerror = () => setTimeout(() => loadInbox().catch(() => {}), 2500);
}

// --- interaction -----------------------------------------------------------

function grow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

function closePanels() {
  $('side').classList.remove('open');
  $('scrim').classList.add('hide');
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeId) return;
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  grow();
  $('send').disabled = true;
  await reply(text);
});

$('input').addEventListener('input', () => {
  grow();
  $('send').disabled = $('input').value.trim().length === 0 || !state.activeId;
  const now = Date.now();
  if (state.activeId && now - state.lastTyping > 3000) {
    state.lastTyping = now;
    api(`/api/owner/conversations/${state.activeId}/typing`, { method: 'POST' }).catch(() => {});
  }
});

$('input').addEventListener('keydown', (event) => {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touch) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('filter').addEventListener('click', () => {
  state.waitingOnly = !state.waitingOnly;
  $('filter').textContent = state.waitingOnly ? 'Showing waiting' : 'Showing all';
  renderList();
});

$('info').addEventListener('click', () => {
  if (!state.activeId) return;
  $('panel').classList.toggle('hide');
});

$('saveNote').addEventListener('click', async () => {
  if (!state.person) return;
  try {
    await api(`/api/owner/users/${state.person.id}`, {
      method: 'PATCH',
      body: { note: $('note').value },
    });
    note($('panelMsg'), 'Saved.');
    setTimeout(() => note($('panelMsg'), ''), 1800);
  } catch (err) {
    note($('panelMsg'), err.message, true);
  }
});

$('block').addEventListener('click', async () => {
  if (!state.person) return;
  const blocking = !state.person.blocked;
  if (!confirm(blocking ? 'Block this person from sending anything else?' : 'Unblock?')) return;
  const data = await api(`/api/owner/users/${state.person.id}`, {
    method: 'PATCH',
    body: { blocked: blocking },
  });
  state.person = { ...state.person, ...data.user };
  $('block').textContent = state.person.blocked ? 'Unblock' : 'Block';
  loadInbox().catch(() => {});
});

$('del').addEventListener('click', async () => {
  if (!state.activeId) return;
  if (!confirm('Delete this conversation for both of you? This cannot be undone.')) return;
  await api(`/api/owner/conversations/${state.activeId}`, { method: 'DELETE' });
  state.activeId = null;
  state.messages = [];
  state.person = null;
  $('title').firstChild.textContent = 'Pick a question';
  $('sub').textContent = '';
  $('panel').classList.add('hide');
  renderStream();
  loadInbox().catch(() => {});
});

$('menu').addEventListener('click', () => {
  $('side').classList.add('open');
  $('scrim').classList.remove('hide');
});
$('scrim').addEventListener('click', closePanels);
$('closeSide').addEventListener('click', closePanels);

$('signOut').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadInbox().catch(() => {});
});

// --- start -----------------------------------------------------------------

(async function start() {
  let me;
  try {
    me = await api('/api/owner/me');
  } catch {
    $('gate').classList.remove('hide');
    return;
  }

  state.ownerName = me.ownerName || 'Reece';
  $('desk').classList.remove('hide');

  if (!me.pushEnabled || (supported() && permission() !== 'granted')) {
    mountBanner({
      bar: $('notifyBar'),
      button: $('notifyBtn'),
      text: $('notifyText'),
      subscribeUrl: '/api/owner/push/subscribe',
      message: 'Get notified when a question comes in.',
      storageKey: 'chatreece:owner-notify-asked',
    });
  }

  await loadInbox();
  renderStream();
  connect();

  const wanted = new URLSearchParams(location.search).get('c');
  const first =
    state.conversations.find((c) => c.id === wanted) ||
    state.conversations.find((c) => c.unread > 0) ||
    state.conversations[0];
  if (first) await open(first.id);
})();
