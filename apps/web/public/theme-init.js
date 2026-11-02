// Runs before first paint so the page never flashes the wrong theme or font size.
// A separate file because the production content security policy forbids inline scripts.
(function () {
  var cached = {};
  try {
    cached = JSON.parse(localStorage.getItem('compilerlab.settings') || '{}') || {};
  } catch {
    cached = {};
  }
  var theme = cached.theme || 'system';
  var dark =
    theme === 'dark' ||
    (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (typeof cached.fontSize === 'number') {
    document.documentElement.style.fontSize = cached.fontSize + 'px';
  }
})();
