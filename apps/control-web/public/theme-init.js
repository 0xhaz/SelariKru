// Applied before first paint so a stored font preference does not flash. There is one theme (the reference's cream and ink).
try {
  document.documentElement.dataset.theme = 'light';
  var font = localStorage.getItem('selarikru.font');
  if (font === 'clean' || font === 'mono') document.documentElement.dataset.font = font;
} catch {}
