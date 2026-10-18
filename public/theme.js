// Apply this device's light/dark choice before the page draws, so it never flashes.
// Kept in step with src/theme.ts.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem('appearance');
  } catch (error) {
    // Storage can be unavailable; follow the system setting.
  }
  var dark =
    choice === 'dark' ||
    (choice !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#151b18' : '#f7f7f2');
})();
