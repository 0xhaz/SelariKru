/** mulberry32: a small seeded PRNG. Fixtures use it for event ids so a seed always yields the same ids; nothing uses `Math.random`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededId(next: () => number, prefix: string): string {
  return `${prefix}_${Math.floor(next() * 0xffffffff).toString(16).padStart(8, '0')}`;
}
