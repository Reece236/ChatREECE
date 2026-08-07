import { api, formatBody, timeLabel, dayLabel, relativeLabel } from './api.js';

const $ = (id) => document.getElementById(id);

// The widget opens /chat?embed=1, but a visitor who signs in from inside the
// bubble navigates to a plain /chat and would otherwise get the full-width
// layout crammed into a 390px iframe. Checking the frame itself covers both.
const embedded =
  new URLSearchParams(location.search).get('embed') === '1' || window.self !== window.top;
if (embedded) {
  document.body.classList.add('embedded');
  document.getElementById('sidebar').classList.add('hidden');
  // Without the sidebar there is nothing for the hamburger to reveal.
  document.getElementById('menuBtn').classList.add('hidden');
  document.querySelector('.shell').style.gridTemplateColumns = '1fr';
}

const state = {
  user: null,
  ownerName: 'Reece',
  ownerOnline: false,
  conversations: [],
  activeId: null,
  messages: [],
  typingTimer: null,
  lastTypingPing: 0,
  baseTitle: 'Chat',
};

const LAST_CHAT_KEY = 'chatreece:lastChat';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderThreads() {
  const list = $('threadList');
  list.innerHTML = '';
  for (const conversation of state.conversations) {
    const button = document.createElement('button');
    button.className = `thread${conversation.id === state.activeId ? ' active' : ''}`;
    button.type = 'button';

    const title = document.createElement('div');
    title.className = 'thread-title';
    if (conversation.unread > 0 && conversation.id !== state.activeId) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      title.appendChild(dot);
    }
    title.appendChild(document.createTextNode(conversation.title || 'New chat'));
    button.appendChild(title);

    if (conversation.preview) {
      const preview = document.createElement('div');
      preview.className = 'thread-preview';
      preview.textContent = conversation.preview;
      button.appendChild(preview);
    }

    const meta = document.createElement('div');
    meta.className = 'thread-meta';
    meta.textContent = relativeLabel(conversation.updated_at);
    button.appendChild(meta);

    button.addEventListener('click', () => {
      closeSidebar();
      openConversation(conversation.id);
    });
    list.appendChild(button);
  }
}

function messageNode(message) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${message.role === 'user' ? 'from-user' : 'from-owner'}`;
  wrap.dataset.id = message.id;

  const avatar = document.createElement('div');
  avatar.className = `avatar ${message.role === 'user' ? 'user' : 'owner'}`;
  avatar.textContent = message.role === 'user' ? 'You' : state.ownerName.slice(0, 1).toUpperCase();
  if (message.role === 'user') avatar.style.fontSize = '9px';

  const stack = document.createElement('div');
  stack.className = 'stack';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = formatBody(message.body);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent =
    message.pending ? 'Sending…' : `${message.role === 'user' ? 'You' : state.ownerName} · ${timeLabel(message.created_at)}`;

  stack.appendChild(bubble);
  stack.appendChild(time);
  wrap.appendChild(avatar);
  wrap.appendChild(stack);
  return wrap;
}

function renderStream() {
  const inner = $('streamInner');
  inner.innerHTML = '';

  if (state.messages.length === 0) {
    inner.appendChild(emptyState());
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

  // A short note after the visitor's last message so nobody sits there
  // wondering whether an instant AI reply is coming. It is not — a person is.
  const last = state.messages[state.messages.length - 1];
  if (last.role === 'user' && !last.pending) {
    const note = document.createElement('div');
    note.className = 'day-sep';
    note.style.textTransform = 'none';
    note.style.letterSpacing = '0';
    note.textContent = state.ownerOnline
      ? `${state.ownerName} is online and will reply here.`
      : `Delivered. ${state.ownerName} replies here — keep your key and check back any time.`;
    inner.appendChild(note);
  }

  scrollToEnd();
}

function emptyState() {
  const box = document.createElement('div');
  box.className = 'empty-state';

  const heading = document.createElement('h2');
  heading.textContent = `Ask ${state.ownerName} anything`;
  const lede = document.createElement('p');
  lede.textContent =
    'Type a question below. It goes straight to a real person, so answers arrive when they arrive — your key brings you back to read them.';
  box.appendChild(heading);
  box.appendChild(lede);

  const grid = document.createElement('div');
  grid.className = 'suggestions';
  const prompts = [
    'What do you do?',
    'Can you help with a project?',
    'How do I get in touch?',
    'What are you working on lately?',
  ];
  for (const prompt of prompts) {
    const button = document.createElement('button');
    button.className = 'suggestion';
    button.type = 'button';
    button.textContent = prompt;
    button.addEventListener('click', () => {
      $('input').value = prompt;
      $('input').focus();
      autosize();
      updateSendState();
    });
    grid.appendChild(button);
  }
  box.appendChild(grid);
  return box;
}

function showTyping(on) {
  const existing = document.getElementById('typingRow');
  if (!on) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;

  const wrap = document.createElement('div');
  wrap.className = 'msg from-owner';
  wrap.id = 'typingRow';

  const avatar = document.createElement('div');
  avatar.className = 'avatar owner';
  avatar.textContent = state.ownerName.slice(0, 1).toUpperCase();

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  $('streamInner').appendChild(wrap);
  scrollToEnd();
}

function scrollToEnd() {
  const stream = $('stream');
  requestAnimationFrame(() => {
    stream.scrollTop = stream.scrollHeight;
  });
}

function setStatus(online) {
  state.ownerOnline = online;
  const pill = $('statusPill');
  pill.classList.toggle('online', online);
  $('statusText').textContent = online ? `${state.ownerName} is online` : `${state.ownerName} is away`;
}

function updateDocTitle() {
  const unread = state.conversations.reduce((sum, c) => sum + (c.id === state.activeId ? 0 : c.unread || 0), 0);
  document.title = unread > 0 ? `(${unread}) ${state.baseTitle}` : state.baseTitle;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadConversations() {
  const data = await api('/api/conversations');
  state.conversations = data.conversations;
  renderThreads();
  updateDocTitle();
}

async function openConversation(id) {
  state.activeId = id;
  localStorage.setItem(LAST_CHAT_KEY, id);
  showTyping(false);
  const data = await api(`/api/conversations/${id}`);
  state.messages = data.messages;
  $('chatTitle').textContent = data.conversation.title || 'New chat';
  $('chatSub').textContent = state.messages.length
    ? `Started ${dayLabel(data.conversation.created_at)}`
    : '';
  const local = state.conversations.find((c) => c.id === id);
  if (local) local.unread = 0;
  renderThreads();
  renderStream();
  updateDocTitle();
}

async function startConversation() {
  const data = await api('/api/conversations', { method: 'POST' });
  state.conversations.unshift(data.conversation);
  await openConversation(data.conversation.id);
  $('input').focus();
}

async function send(text) {
  if (!state.activeId) await startConversation();

  const clientId = `c${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const optimistic = {
    id: `pending-${clientId}`,
    clientId,
    role: 'user',
    body: text,
    created_at: Date.now(),
    pending: true,
  };
  state.messages.push(optimistic);
  renderStream();

  try {
    const data = await api(`/api/conversations/${state.activeId}/messages`, {
      method: 'POST',
      body: { body: text, clientId },
    });
    const index = state.messages.findIndex((m) => m.id === optimistic.id);
    if (index >= 0) state.messages[index] = { ...data.message, clientId };
    setStatus(Boolean(data.ownerOnline));
    $('chatTitle').textContent = data.title;
    const local = state.conversations.find((c) => c.id === state.activeId);
    if (local) {
      local.title = data.title;
      local.preview = text.slice(0, 120);
      local.updated_at = data.message.created_at;
    }
    state.conversations.sort((a, b) => b.updated_at - a.updated_at);
    renderThreads();
    renderStream();
  } catch (err) {
    state.messages = state.messages.filter((m) => m.id !== optimistic.id);
    renderStream();
    const inner = $('streamInner');
    const warn = document.createElement('div');
    warn.className = 'notice notice-bad';
    warn.textContent = err.message;
    inner.appendChild(warn);
    $('input').value = text;
    autosize();
    updateSendState();
  }
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * The stream echoes back messages this tab just sent, and the echo can beat
 * the POST response. Matching on our own clientId catches it either way.
 */
function alreadyShown(message) {
  return state.messages.some(
    (m) => m.id === message.id || (message.clientId && m.clientId === message.clientId),
  );
}

function connectEvents() {
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
      if (!alreadyShown(payload.message)) {
        state.messages.push(payload.message);
        renderStream();
      }
      api(`/api/conversations/${state.activeId}/read`, { method: 'POST' }).catch(() => {});
    } else {
      const local = state.conversations.find((c) => c.id === payload.conversationId);
      if (local) {
        // Only an answer counts as unread; our own message echoed from another
        // tab does not.
        if (payload.message.role === 'owner') local.unread = (local.unread || 0) + 1;
        local.preview = payload.message.body.slice(0, 120);
        local.updated_at = payload.message.created_at;
        state.conversations.sort((a, b) => b.updated_at - a.updated_at);
        renderThreads();
        updateDocTitle();
      } else {
        loadConversations().catch(() => {});
      }
    }
  });

  source.addEventListener('typing', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.conversationId !== state.activeId) return;
    showTyping(true);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => showTyping(false), 6000);
  });

  source.addEventListener('removed', (event) => {
    const payload = JSON.parse(event.data);
    state.conversations = state.conversations.filter((c) => c.id !== payload.conversationId);
    if (payload.conversationId === state.activeId) {
      state.activeId = null;
      state.messages = [];
      renderStream();
    }
    renderThreads();
  });

  source.onerror = () => {
    // EventSource reconnects on its own; refresh the list once it is back so
    // anything missed while offline shows up.
    setTimeout(() => loadConversations().catch(() => {}), 2500);
  };
}

function pingTyping() {
  const now = Date.now();
  if (!state.activeId || now - state.lastTypingPing < 3000) return;
  state.lastTypingPing = now;
  api(`/api/conversations/${state.activeId}/typing`, { method: 'POST' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

function updateSendState() {
  $('sendBtn').disabled = $('input').value.trim().length === 0;
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('scrim').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  updateSendState();
  await send(text);
  input.focus();
});

$('input').addEventListener('input', () => {
  autosize();
  updateSendState();
  pingTyping();
});

$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('newChatBtn').addEventListener('click', () => {
  closeSidebar();
  startConversation().catch((err) => alert(err.message));
});

$('signOutBtn').addEventListener('click', async () => {
  const ok = confirm('Sign out on this device? You will need your key to get back in.');
  if (!ok) return;
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem(LAST_CHAT_KEY);
  location.replace('/?switch=1');
});

$('menuBtn').addEventListener('click', () => {
  $('sidebar').classList.add('open');
  $('scrim').classList.remove('hidden');
});
$('scrim').addEventListener('click', closeSidebar);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeId) {
    api(`/api/conversations/${state.activeId}/read`, { method: 'POST' }).catch(() => {});
    loadConversations().catch(() => {});
  }
});

// ---------------------------------------------------------------------------

(async function start() {
  let me;
  try {
    me = await api('/api/me');
  } catch {
    location.replace('/');
    return;
  }

  state.user = me.user;
  state.ownerName = me.ownerName || 'Reece';
  state.baseTitle = `Chat with ${state.ownerName}`;
  document.title = state.baseTitle;
  $('whoami').textContent = me.user.displayName ? `Hi, ${me.user.displayName}` : 'Signed in with your key';
  $('input').placeholder = `Ask ${state.ownerName} a question…`;
  setStatus(Boolean(me.ownerOnline));

  await loadConversations();

  const remembered = localStorage.getItem(LAST_CHAT_KEY);
  const target =
    state.conversations.find((c) => c.id === remembered) || state.conversations[0];
  if (target) await openConversation(target.id);
  else await startConversation();

  connectEvents();
  updateSendState();
  $('input').focus();
})();
