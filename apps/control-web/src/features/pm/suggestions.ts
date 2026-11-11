/**
 * H11 fix round 1 (M11): the Search Suggestions markup keeps its content, links and styles, but nothing that runs: no script, no inline event handler, no
 * javascript: link, no frame or object. A shadow root keeps its styles from leaking; innerHTML never runs a script, but an on* attribute would.
 */
export function sanitizeSuggestions(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, base, meta, link[rel="import"]').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const v = a.value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
      if (a.name.toLowerCase().startsWith('on') || ((a.name === 'href' || a.name === 'src' || a.name === 'xlink:href' || a.name === 'action' || a.name === 'formaction') && (v.startsWith('javascript:') || v.startsWith('data:text/html')))) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

