// Applied before first paint so a light-theme preference does not flash dark.
try { if (localStorage.getItem('selarikru.theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch {}
