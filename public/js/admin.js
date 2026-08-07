import { api, formatBody, timeLabel, dayLabel, relativeLabel } from './api.js';

const $ = (id) => document.getElementById(id);

const state = {
  ownerName: 'Reece',
  conversations: [],
  activeId: null,
  activeUser: null,
  messages: [],
  waitingOnly: false,
  lastTypingPing: 0,
  typingTimer: null,
  sentClientIds: new Set(),
};

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function notice(target, message, kind = 'bad') {
  target.innerHTML = '';
  if (!message) return;
  const div = document.createElement('div');
  div.className = `notice notice-${kind}`;
  div.textContent = message;
  target.appendChild(div);
}

$('gateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice($('gateNotice'), '');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { key: $('gateKey').value },
    });
    if (!data.owner) {
      notice($('gateNotice'), 'That is a visitor key. Use /chat to open that conversation.');
      return;
    }
    location.reload();
  } catch (err) {
    notice($('gateNotice'), err.message);
  }
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

function visibleConversations() {
  return state.waitingOnly ? state.conversations.filter((c) => c.unread > 0) : state.conversations;
}

function renderInbox() {
  const list = $('inboxList');
  list.innerHTML = '';

  const rows = visibleConversations();
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'fine';
    empty.style.padding = '20px 12px';
    empty.textContent = state.waitingOnly ? 'Nothing waiting. Nice.' : 'No questions yet.';
    list.appendChild(empty);
  }

  for (const conversation of rows) {
    const button = document.createElement('button');
    button.className = `thread${conversation.id === state.activeId ? ' active' : ''}`;
    button.type = 'button';

    const title = document.createElement('div');
    title.className = 'thread-title';
    title.appendChild(
      document.createTextNode(conversation.display_name || conversation.title || 'Visitor'),
    );
    if (conversation.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(conversation.unread);
      title.appendChild(badge);
    }
    button.appendChild(title);

    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    const speaker = conversation.last_role === 'owner' ? 'You: ' : '';
    preview.textContent = `${speaker}${conversation.last_body || conversation.title || ''}`;
    button.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'thread-meta';
    const left = document.createElement('span');
    left.textContent = relativeLabel(conversation.updated_at);
    const right = document.createElement('span');
    if (conversation.blocked) {
      right.textContent = 'blocked';
      right.style.color = 'var(--bad)';
    } else if (conversation.last_role === 'user') {
      right.textContent = 'needs a reply';
      right.style.color = 'var(--warn)';
    }
    meta.appendChild(left);
    meta.appendChild(right);
    button.appendChild(meta);

    button.addEventListener('click', () => {
      closePanels();
      openConversation(conversation.id);
    });
    list.appendChild(button);
  }

  const unread = state.conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
  $('inboxSummary').textContent = unread ? `${unread} waiting on you` : 'All caught up';
  $('deskStats').textContent = `${state.conversations.length} conversation${
    state.conversations.length === 1 ? '' : 's'
  }`;
  document.title = unread ? `(${unread}) Answering desk` : 'Answering desk';
}

async function loadInbox() {
  const data = await api('/api/owner/inbox');
  state.conversations = data.conversations;
  renderInbox();
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function messageNode(message) {
  // The owner sits where the AI sits in a normal chatbot: left side, brand
  // avatar. The visitor's own messages stay on the right.
  const wrap = document.createElement('div');
  wrap.className = `msg ${message.role === 'user' ? 'from-user' : 'from-owner'}`;

  const avatar = document.createElement('div');
  avatar.className = `avatar ${message.role === 'user' ? 'user' : 'owner'}`;
  avatar.textContent =
    message.role === 'user'
      ? (state.activeUser?.displayName || 'V').slice(0, 1).toUpperCase()
      : state.ownerName.slice(0, 1).toUpperCase();

  const stack = document.createElement('div');
  stack.className = 'stack';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = formatBody(message.body);

  const time = document.createElement('div');
  time.className = 'msg-time';
  const who = message.role === 'user' ? state.activeUser?.displayName || 'Visitor' : 'You';
  time.textContent = `${who} · ${timeLabel(message.created_at)}`;

  stack.appendChild(bubble);
  stack.appendChild(time);
  wrap.appendChild(avatar);
  wrap.appendChild(stack);
  return wrap;
}

function renderStream() {
  const inner = $('streamInner');
  inner.innerHTML = '';

  if (!state.activeId) {
    const box = document.createElement('div');
    box.className = 'empty-state';
    box.innerHTML =
      '<h2>Your answering desk</h2><p>Questions from your site land in the list on the left. Open one and reply whenever you like — they see your answer where a bot reply would normally appear.</p>';
    inner.appendChild(box);
    return;
  }

  let lastDay = '';
  for (const message of state.messages) {
    const day = dayLabel(message.created_at);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      inner.appendChild(sep);
      lastDay = day;
    }
    inner.appendChild(messageNode(message));
  }

  const stream = $('stream');
  requestAnimationFrame(() => {
    stream.scrollTop = stream.scrollHeight;
  });
}

async function openConversation(id) {
  state.activeId = id;
  const data = await api(`/api/owner/conversations/${id}`);
  state.messages = data.messages;
  state.activeUser = data.user;

  $('threadTitle').textContent = data.conversation.title || 'Conversation';
  delete $('threadSub').dataset.base;
  $('threadSub').textContent = `${data.user?.displayName || 'Anonymous visitor'} · started ${dayLabel(
    data.conversation.created_at,
  )}`;
  $('visitorName').textContent = data.user?.displayName || 'Anonymous visitor';
  $('visitorMeta').textContent = data.user
    ? `First seen ${dayLabel(data.user.createdAt)} · last active ${relativeLabel(data.user.lastSeenAt)}`
    : '';
  $('noteBox').value = data.user?.note || '';
  $('blockBtn').textContent = data.user?.blocked ? 'Unblock this key' : 'Block this key';

  const local = state.conversations.find((c) => c.id === id);
  if (local) local.unread = 0;
  renderInbox();
  renderStream();
  $('input').focus();
}

async function reply(text) {
  const clientId = `o${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.sentClientIds.add(clientId);
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
    const index = state.messages.findIndex((m) => m.id === optimistic.id);
    if (index >= 0) state.messages[index] = data.message;
    const local = state.conversations.find((c) => c.id === state.activeId);
    if (local) {
      local.last_body = text.slice(0, 120);
      local.last_role = 'owner';
      local.updated_at = data.message.created_at;
      local.unread = 0;
    }
    state.conversations.sort((a, b) => b.updated_at - a.updated_at);
    renderInbox();
    renderStream();
  } catch (err) {
    state.messages = state.messages.filter((m) => m.id !== optimistic.id);
    renderStream();
    alert(err.message);
    $('input').value = text;
  }
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

function connectEvents() {
  const source = new EventSource('/api/owner/events');

  source.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    const message = payload.message;

    // Replies sent from this tab are already on screen. Replies from another
    // desk tab are not, so match on clientId rather than skipping every
    // owner-authored message.
    if (message.clientId && state.sentClientIds.has(message.clientId)) return;

    if (payload.conversationId === state.activeId) {
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
      renderInbox();
    } else {
      loadInbox().catch(() => {});
    }
  });

  source.addEventListener('typing', (event) => {
    // Nice to know someone is mid-sentence, but it should not steal focus.
    const payload = JSON.parse(event.data);
    if (payload.conversationId !== state.activeId) return;
    const sub = $('threadSub');
    if (!sub.dataset.base) sub.dataset.base = sub.textContent;
    sub.textContent = 'typing…';
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      sub.textContent = sub.dataset.base || '';
      delete sub.dataset.base;
    }, 5000);
  });

  source.addEventListener('conversation', () => loadInbox().catch(() => {}));
  source.addEventListener('user', () => loadInbox().catch(() => {}));
  source.addEventListener('removed', () => loadInbox().catch(() => {}));

  source.onerror = () => setTimeout(() => loadInbox().catch(() => {}), 2500);
}

// ---------------------------------------------------------------------------
// Composer + rail actions
// ---------------------------------------------------------------------------

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

function closePanels() {
  $('sidebar').classList.remove('open');
  $('rail').classList.remove('open');
  $('scrim').classList.add('hidden');
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeId) return;
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  autosize();
  $('sendBtn').disabled = true;
  await reply(text);
  $('input').focus();
});

$('input').addEventListener('input', () => {
  autosize();
  $('sendBtn').disabled = $('input').value.trim().length === 0 || !state.activeId;
  const now = Date.now();
  if (state.activeId && now - state.lastTypingPing > 3000) {
    state.lastTypingPing = now;
    api(`/api/owner/conversations/${state.activeId}/typing`, { method: 'POST' }).catch(() => {});
  }
});

$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('filterBtn').addEventListener('click', () => {
  state.waitingOnly = !state.waitingOnly;
  $('filterBtn').textContent = state.waitingOnly ? 'Waiting' : 'All';
  renderInbox();
});

$('saveNoteBtn').addEventListener('click', async () => {
  if (!state.activeUser) return;
  try {
    await api(`/api/owner/users/${state.activeUser.id}`, {
      method: 'PATCH',
      body: { note: $('noteBox').value },
    });
    notice($('noteNotice'), 'Saved.', 'good');
    setTimeout(() => notice($('noteNotice'), ''), 2000);
  } catch (err) {
    notice($('noteNotice'), err.message);
  }
});

$('blockBtn').addEventListener('click', async () => {
  if (!state.activeUser) return;
  const blocking = !state.activeUser.blocked;
  const ok = confirm(
    blocking
      ? 'Block this key? Their key stops working and they cannot send anything else.'
      : 'Unblock this key?',
  );
  if (!ok) return;
  const data = await api(`/api/owner/users/${state.activeUser.id}`, {
    method: 'PATCH',
    body: { blocked: blocking },
  });
  state.activeUser = { ...state.activeUser, ...data.user };
  $('blockBtn').textContent = state.activeUser.blocked ? 'Unblock this key' : 'Block this key';
  loadInbox().catch(() => {});
});

$('deleteBtn').addEventListener('click', async () => {
  if (!state.activeId) return;
  if (!confirm('Delete this conversation for both of you? This cannot be undone.')) return;
  await api(`/api/owner/conversations/${state.activeId}`, { method: 'DELETE' });
  state.activeId = null;
  state.messages = [];
  state.activeUser = null;
  $('threadTitle').textContent = 'Pick a conversation';
  $('threadSub').textContent = '';
  renderStream();
  loadInbox().catch(() => {});
});

$('signOutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

$('menuBtn').addEventListener('click', () => {
  $('sidebar').classList.add('open');
  $('scrim').classList.remove('hidden');
});
$('railBtn').addEventListener('click', () => {
  $('rail').classList.add('open');
  $('scrim').classList.remove('hidden');
});
$('scrim').addEventListener('click', closePanels);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadInbox().catch(() => {});
});

// ---------------------------------------------------------------------------

(async function start() {
  try {
    const me = await api('/api/owner/me');
    state.ownerName = me.ownerName || 'Reece';
  } catch {
    $('gate').classList.remove('hidden');
    $('gateKey').focus();
    return;
  }

  $('gate').classList.add('hidden');
  $('desk').classList.remove('hidden');

  await loadInbox();
  renderStream();
  connectEvents();

  const first = state.conversations.find((c) => c.unread > 0) || state.conversations[0];
  if (first) await openConversation(first.id);
})();
