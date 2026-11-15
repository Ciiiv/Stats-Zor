/* Light/dark toggle. Loaded in <head> so the saved choice applies before the page paints.
   Auto follows the device setting; the choice is remembered in this browser only. */
(function () {
  var KEY = 'sz-theme', MODES = ['auto', 'dark', 'light'], LABEL = { auto: 'Theme: auto', dark: 'Theme: dark', light: 'Theme: light' };
  function get() { try { var v = localStorage.getItem(KEY); return MODES.indexOf(v) >= 0 ? v : 'auto'; } catch (e) { return 'auto'; } }
  function apply(m) { var r = document.documentElement; if (m === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', m); }
  apply(get());
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.querySelector('.brandbox'); if (!box) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'themebtn'; b.textContent = LABEL[get()];
    b.title = 'Switch between following your device, always dark, and always light';
    b.addEventListener('click', function () {
      var m = MODES[(MODES.indexOf(get()) + 1) % MODES.length];
      try { if (m === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, m); } catch (e) { /* storage blocked: applies until reload */ }
      apply(m); b.textContent = LABEL[m];
      window.dispatchEvent(new Event('resize'));
    });
    box.appendChild(b);
  });
})();
