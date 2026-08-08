/*
 * Drop-in chat bubble for an existing site.
 *
 *   <script src="https://chat.example.com/embed.js" defer></script>
 *
 * Optional data attributes on that script tag:
 *   data-label="Ask me anything"   button text on hover / aria label
 *   data-position="left"           defaults to "right"
 *   data-accent="#6f8cff"          bubble colour
 *   data-open="1"                  start expanded
 *
 * Everything lives in a shadow root so the host page's CSS cannot reach in
 * and the widget's CSS cannot leak out.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var origin = new URL(script.src, location.href).origin;
  var label = script.getAttribute('data-label') || 'Ask a question';
  var position = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var accent = script.getAttribute('data-accent') || '#1a4fd0';
  var startOpen = script.getAttribute('data-open') === '1';

  var host = document.createElement('div');
  host.setAttribute('data-chatreece', '');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + position + ':0;';
  document.body.appendChild(host);

  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.launcher{position:fixed;bottom:20px;' + position + ':20px;height:56px;min-width:56px;',
    'border-radius:28px;border:0;background:' + accent + ';color:#fff;cursor:pointer;',
    'box-shadow:0 10px 30px rgba(0,0,0,.28);display:flex;align-items:center;gap:9px;',
    'padding:0 18px;font-size:15px;font-weight:600;transition:transform .15s ease}',
    '.launcher:hover{transform:translateY(-2px)}',
    '.launcher .txt{display:none}',
    '@media(min-width:560px){.launcher .txt{display:inline}}',
    '.panel{position:fixed;bottom:88px;' + position + ':20px;width:390px;height:min(620px,calc(100vh - 120px));',
    // No background here: the iframe paints its own, and a colour underneath
    // would show as a mismatched ring at the rounded corners in light mode.
    'border-radius:8px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.28);',
    'display:none;flex-direction:column}',
    '.panel.open{display:flex}',
    '.panel iframe{border:0;width:100%;height:100%;display:block}',
    '@media(max-width:520px){.panel{inset:0;width:100%;height:100%;border-radius:0;bottom:0}',
    '.panel.open + .launcher{display:none}}',
  ].join('');
  root.appendChild(style);

  var panel = document.createElement('div');
  panel.className = 'panel';
  var frame = document.createElement('iframe');
  frame.title = label;
  frame.setAttribute('allow', 'clipboard-write');
  panel.appendChild(frame);

  var launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', label);
  launcher.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>' +
    '</svg><span class="txt"></span>';
  launcher.querySelector('.txt').textContent = label;

  root.appendChild(panel);
  root.appendChild(launcher);

  var loaded = false;
  function toggle(force) {
    var open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    // The iframe is only loaded the first time it is actually opened, so the
    // widget costs the host page nothing until someone wants it.
    if (open && !loaded) {
      frame.src = origin + '/chat?embed=1';
      loaded = true;
    }
  }

  launcher.addEventListener('click', function () {
    toggle();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') toggle(false);
  });

  if (startOpen) toggle(true);

  // Let a host page drive it: window.ChatREECE.open() / .close() / .toggle()
  window.ChatREECE = {
    open: function () {
      toggle(true);
    },
    close: function () {
      toggle(false);
    },
    toggle: toggle,
  };
})();
