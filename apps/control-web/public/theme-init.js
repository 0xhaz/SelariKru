// Applied before first paint so a stored theme or font preference does not flash. Light (cream and ink) is the default.
try {
  document.documentElement.dataset.theme = localStorage.getItem('selarikru.theme') === 'dark' ? 'dark' : 'light';
  var font = localStorage.getItem('selarikru.font');
  if (font === 'clean' || font === 'mono') document.documentElement.dataset.font = font;
} catch {}
