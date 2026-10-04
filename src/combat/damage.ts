import type { DamageType, HullSize } from '../ships/defs';

/**
 * Damage model (SUPERPLAN §3.5), after Starsector:
 * - kinetic is good against shields and poor against armour,
 * - high explosive is the opposite,
 * - energy is neutral,
 * - fragmentation is weak against shields and armour but fine against bare hull and missiles.
 */
export const SHIELD_MULT: Record<DamageType, number> = { kinetic: 2, he: 0.5, energy: 1, frag: 0.25 };
export const ARMOR_MULT: Record<DamageType, number> = { kinetic: 0.5, he: 2, energy: 1, frag: 0.25 };
export const MISSILE_MULT: Record<DamageType, number> = { kinetic: 1, he: 1, energy: 1, frag: 2 };

/** Armour never reduces a hit by more than this fraction (min damage factor). */
export const MIN_ARMOR_FACTOR = 0.15;
/** Stripped armour still counts as this fraction of the rating when reducing hits. */
export const RESIDUAL_ARMOR = 0.05;

export const ARMOR_CELLS: Record<HullSize, number> = { frigate: 8, destroyer: 10, cruiser: 12, capital: 16 };

/** Hard flux a shield takes from a hit. */
export function shieldFlux(damage: number, type: DamageType, efficiency: number): number {
  return damage * SHIELD_MULT[type] * efficiency;
}

export interface ArmorHit {
  /** Damage absorbed by the armour cells. */
  armor: number;
  /** Damage that reached the hull. */
  hull: number;
}

/**
 * The armour grid: cells around the hull's perimeter, indexed by bearing in
 * ship-local space. A hit is reduced by the armour around its cell (centre
 * cell weighted most), strips those cells, and only what gets through the
 * stripped cells reaches the hull. Hits keep landing on the same side, so
 * focused fire breaks through while spread fire wears everything down.
 */
export class ArmorGrid {
  readonly cells: Float64Array;

  constructor(
    readonly rating: number,
    readonly count: number,
  ) {
    this.cells = new Float64Array(count).fill(rating);
  }

  /** Cell index for a bearing (radians, 0 = nose, positive = port). */
  cellAt(bearing: number): number {
    const n = this.count;
    const f = (((bearing / (Math.PI * 2)) % 1) + 1) % 1;
    return Math.min(n - 1, Math.floor(f * n + 0.5) % n);
  }

  /** Effective armour at a cell: centre half, neighbours a quarter each. */
  armorAt(i: number): number {
    const n = this.count;
    const c = this.cells;
    return c[i] * 0.5 + c[(i + 1) % n] * 0.25 + c[(i + n - 1) % n] * 0.25;
  }

  /** Fraction of armour remaining overall (0..1). */
  get fraction(): number {
    if (this.rating <= 0) return 0;
    let s = 0;
    for (const c of this.cells) s += c;
    return s / (this.rating * this.count);
  }

  /**
   * Apply a hit to cell `i`. `strength` is the hit size used for the armour
   * reduction; beams deal many tiny ticks, so they pass their per-second
   * damage (scaled) here instead of the tick's damage.
   */
  hit(i: number, damage: number, type: DamageType, strength = damage): ArmorHit {
    const mult = ARMOR_MULT[type];
    const hit = damage * mult;
    if (hit <= 0) return { armor: 0, hull: 0 };
    const armorValue = Math.max(this.armorAt(i), this.rating * RESIDUAL_ARMOR);
    const s = strength * mult;
    const factor = Math.max(MIN_ARMOR_FACTOR, s / (s + armorValue));
    const dealt = hit * factor;
    const n = this.count;
    let absorbed = 0;
    let overflow = 0;
    for (const [j, w] of [
      [i, 0.5],
      [(i + 1) % n, 0.25],
      [(i + n - 1) % n, 0.25],
    ] as const) {
      const take = dealt * w;
      const a = Math.min(this.cells[j], take);
      this.cells[j] -= a;
      absorbed += a;
      overflow += take - a;
    }
    // What got past the armour hits the hull at the weapon's normal (unmultiplied) strength.
    return { armor: absorbed, hull: overflow / mult };
  }

  restore(): void {
    this.cells.fill(this.rating);
  }
}
