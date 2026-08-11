export function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class SeededRng {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const result = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    this.state >>>= 0;
    return result;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  pick<T>(values: T[]): T {
    return values[this.int(values.length)];
  }

  weightedIndex(weights: number[]): number {
    const safe = weights.map((weight) => Math.max(0, weight));
    const total = safe.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return this.int(weights.length);
    let cursor = this.next() * total;
    for (let index = 0; index < safe.length; index += 1) {
      cursor -= safe[index];
      if (cursor <= 0) return index;
    }
    return safe.length - 1;
  }

  shuffle<T>(values: T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = this.int(index + 1);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }
}

export function makeSeed(prefix = "hand"): string {
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
