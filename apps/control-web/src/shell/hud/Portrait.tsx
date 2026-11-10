// Adapted from jsm-hq (MIT), see THIRD_PARTY_NOTICES.md

import { useEffect, useRef } from 'react';
import { robotCanvases } from '../../office/draw/robots.ts';

/** A worker's robot, drawn from the same sprite as the office. Decoration: the row beside it says who it is. */
export function Portrait({ color, size = 28 }: { color: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current?.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 16, 16);
    g.drawImage(robotCanvases(color).front, 2, 1);
  }, [color]);
  return <canvas ref={ref} width={16} height={16} aria-hidden="true" className="pixelated shrink-0 border-2 border-edge bg-[#1d2b53]" style={{ width: size, height: size }} />;
}
