// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md
//
// Pixel drawing on a 2D canvas. Every drawing helper takes a Pen. The reference drew its live layer through PixiJS; here everything is a
// plain canvas, so the office needs no WebGL and no extra dependency.

export interface Pen {
  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
}

export class CanvasPen implements Pen {
  constructor(public g: CanvasRenderingContext2D) {
    g.imageSmoothingEnabled = false;
  }
  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    this.g.globalAlpha = alpha;
    this.g.fillStyle = color;
    this.g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    this.g.globalAlpha = 1;
  }
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** Filled box with a 1px outline. */
export function box(p: Pen, x: number, y: number, w: number, h: number, fill: string, outline = '#241a2e'): void {
  p.rect(x, y, w, h, outline);
  p.rect(x + 1, y + 1, w - 2, h - 2, fill);
}

export function disc(p: Pen, cx: number, cy: number, r: number, color: string, alpha = 1): void {
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.round(Math.sqrt(r * r - dy * dy));
    p.rect(cx - w, cy + dy, w * 2 + 1, 1, color, alpha);
  }
}

export function ellipse(p: Pen, cx: number, cy: number, rx: number, ry: number, color: string, alpha = 1): void {
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.round(rx * Math.sqrt(1 - (dy * dy) / (ry * ry)));
    p.rect(cx - w, cy + dy, w * 2 + 1, 1, color, alpha);
  }
}

export function line(p: Pen, x0: number, y0: number, x1: number, y1: number, color: string): void {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    p.rect(ax, ay, 1, 1, color);
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      ax += sx;
    }
    if (e2 < dx) {
      err += dx;
      ay += sy;
    }
  }
}

/** Builds a canvas from rows of characters; each char maps to a colour ('.' = clear). */
export function spriteCanvas(rows: readonly string[], pal: Readonly<Record<string, string>>): HTMLCanvasElement {
  const c = makeCanvas(rows[0]!.length, rows.length);
  const pen = new CanvasPen(c.getContext('2d')!);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { const col = pal[ch]; if (col) pen.rect(x, y, 1, 1, col); }));
  return c;
}

export function flipCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const g = c.getContext('2d')!;
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}

/** Draws sprite rows straight onto a pen (used for small live sprites). */
export function drawRows(p: Pen, rows: readonly string[], pal: Readonly<Record<string, string>>, x: number, y: number): void {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const col = pal[row[dx]!];
      if (col) p.rect(x + dx, y + dy, 1, 1, col);
    }
  });
}
