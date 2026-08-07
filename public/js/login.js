import { api } from './api.js';

const $ = (id) => document.getElementById(id);

const stepStart = $('stepStart');
const stepKey = $('stepKey');
const startNotice = $('startNotice');
const keyNotice = $('keyNotice');
const newKeyBtn = $('newKeyBtn');
const loginForm = $('loginForm');
const loginBtn = $('loginBtn');
const keyInput = $('keyInput');
const keyText = $('keyText');
const copyBtn = $('copyBtn');
const continueBtn = $('continueBtn');

function notice(target, message, kind = 'bad') {
  target.innerHTML = '';
  if (!message) return;
  const div = document.createElement('div');
  div.className = `notice notice-${kind}`;
  div.textContent = message;
  target.appendChild(div);
}

// Someone arriving with a live session should land straight in their chat.
// ?switch=1 is the escape hatch for signing in with a different key.
(async function bootstrap() {
  const params = new URLSearchParams(location.search);
  try {
    const config = await api('/api/config');
    document.title = config.siteName;
    $('brandName').textContent = config.siteName;
    $('brandMark').textContent = (config.ownerName || 'R').slice(0, 1).toUpperCase();
    keyInput.placeholder = `meadow-drifting-${'4'.repeat(config.keyDigits || 3)}`;
    document.querySelector('.brand-sub').textContent =
      `Ask anything. ${config.ownerName} answers personally.`;
  } catch {
    /* Defaults in the markup are good enough. */
  }

  if (params.get('switch') === '1') return;
  try {
    await api('/api/me');
    location.replace('/chat');
  } catch {
    /* Not signed in — stay here. */
  }
})();

newKeyBtn.addEventListener('click', async () => {
  newKeyBtn.disabled = true;
  newKeyBtn.textContent = 'Making your key…';
  notice(startNotice, '');
  try {
    const data = await api('/api/auth/new', { method: 'POST', body: {} });
    keyText.textContent = data.key;
    stepStart.classList.add('hidden');
    stepKey.classList.remove('hidden');
  } catch (err) {
    notice(startNotice, err.message);
  } finally {
    newKeyBtn.disabled = false;
    newKeyBtn.textContent = 'Get my key and start';
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    notice(startNotice, 'Type your key first.');
    return;
  }
  loginBtn.disabled = true;
  notice(startNotice, '');
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { key } });
    location.replace(data.redirect || '/chat');
  } catch (err) {
    notice(startNotice, err.message);
    loginBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  const key = keyText.textContent;
  try {
    await navigator.clipboard.writeText(key);
    notice(keyNotice, 'Copied. Paste it somewhere safe.', 'good');
  } catch {
    // Clipboard access is blocked in some embedded contexts; selecting the
    // text is the next best thing.
    const range = document.createRange();
    range.selectNodeContents(keyText);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    notice(keyNotice, 'Copy blocked by your browser — the key is selected, press Ctrl/Cmd+C.');
  }
});

continueBtn.addEventListener('click', () => {
  location.href = '/chat';
});
