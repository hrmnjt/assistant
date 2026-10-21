// Basecoat's dark theme follows a `dark` class on the page; keep it in step with the device.
{
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const follow = () => document.documentElement.classList.toggle('dark', dark.matches);
  follow();
  dark.addEventListener('change', follow);
}
