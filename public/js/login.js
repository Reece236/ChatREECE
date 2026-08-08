import { api } from './api.js';

const $ = (id) => document.getElementById(id);

function show(el, on) {
  el.classList.toggle('hide', !on);
}

function fail(el, message) {
  el.textContent = message;
  show(el, Boolean(message));
}

function selectTab(signingIn) {
  $('tabIn').setAttribute('aria-selected', String(signingIn));
  $('tabUp').setAttribute('aria-selected', String(!signingIn));
  show($('formIn'), signingIn);
  show($('formUp'), !signingIn);
  fail($('inErr'), '');
  fail($('upErr'), '');
  // Deliberately no autofocus: on a phone it throws the keyboard up over the
  // page before you have read anything.
}

$('tabIn').addEventListener('click', () => selectTab(true));
$('tabUp').addEventListener('click', () => selectTab(false));

async function submit({ url, form, button, errBox, label }) {
  const data = new FormData(form);
  fail(errBox, '');
  button.disabled = true;
  button.textContent = 'Just a moment…';
  try {
    const result = await api(url, {
      method: 'POST',
      body: {
        username: String(data.get('username') || '').trim(),
        password: String(data.get('password') || ''),
      },
    });
    location.replace(result.redirect || '/chat');
  } catch (err) {
    fail(errBox, err.message);
    button.disabled = false;
    button.textContent = label;
    // Put the cursor where the problem is so a phone user does not have to hunt.
    const field = err.field === 'username' ? form.querySelector('[name=username]') : null;
    if (field) field.focus();
  }
}

$('formUp').addEventListener('submit', (event) => {
  event.preventDefault();
  submit({
    url: '/api/auth/signup',
    form: $('formUp'),
    button: $('upBtn'),
    errBox: $('upErr'),
    label: 'Create account',
  });
});

$('formIn').addEventListener('submit', (event) => {
  event.preventDefault();
  submit({
    url: '/api/auth/login',
    form: $('formIn'),
    button: $('inBtn'),
    errBox: $('inErr'),
    label: 'Sign in',
  });
});

(async function start() {
  const params = new URLSearchParams(location.search);
  if (params.get('signin') === '1') selectTab(true);

  try {
    const config = await api('/api/config');
    document.title = `Sign in · ${config.siteName}`;
    $('title').textContent = config.siteName;
    $('sub').textContent = `Ask a question. ${config.ownerName} answers personally.`;
    $('upHint').textContent = `At least ${config.passwordMin} characters.`;
    $('upPass').minLength = config.passwordMin;
  } catch {
    /* The markup already says something sensible. */
  }

  // Already signed in on this device? Skip straight past the form.
  if (params.get('switch') === '1') return;
  try {
    await api('/api/me');
    location.replace('/chat');
  } catch {
    /* Not signed in — stay on the form. */
  }
})();
