import {
  type DamageType,
  HULL_SIZES,
  type HullDef,
  type HullSize,
  type HullmodDef,
  type Loadout,
  type ShipStyle,
  type SlotDef,
  type SlotSize,
  type SlotType,
  type WeaponDef,
  WEAPONS,
  hull as hullDef,
  hullmod,
  weapon,
} from './defs';

/** Max vents / capacitors per hull size (each costs 1 OP). */
export const MAX_VENTS: Record<HullSize, number> = { frigate: 10, destroyer: 20, cruiser: 30, capital: 50 };
export const VENT_DISSIPATION = 10;
export const CAPACITOR_FLUX = 200;

const SIZE_RANK: Record<SlotSize, number> = { S: 0, M: 1, L: 2 };

export function sizeIndex(h: HullDef): number {
  return HULL_SIZES.indexOf(h.size);
}

/** Which weapon types a slot accepts. */
export function slotAccepts(type: SlotType): WeaponDef['type'][] {
  switch (type) {
    case 'universal':
      return ['ballistic', 'energy', 'missile'];
    case 'hybrid':
      return ['ballistic', 'energy'];
    case 'composite':
      return ['ballistic', 'missile'];
    case 'synergy':
      return ['energy', 'missile'];
    default:
      return [type];
  }
}

/** Why a weapon can't go in a slot (ignoring OP), or null if it fits. */
export function slotIncompatibility(slot: SlotDef, w: WeaponDef): string | null {
  if (!slotAccepts(slot.type).includes(w.type)) return `${slot.type} slot can't mount ${w.type} weapons`;
  const diff = SIZE_RANK[slot.size] - SIZE_RANK[w.size];
  if (diff < 0) return `Too large for a ${slot.size} slot`;
  if (diff > 1) return `Too small for a ${slot.size} slot`;
  return null;
}

export function hullmodCost(mod: HullmodDef, h: HullDef): number {
  return mod.op[sizeIndex(h)];
}

/** Why a hullmod can't be installed on this hull (ignoring OP), or null. */
export function hullmodIncompatibility(mod: HullmodDef, h: HullDef, installed: string[]): string | null {
  if (h.builtInMods.includes(mod.id)) return 'Built in';
  if (mod.notSizes?.includes(h.size)) return `Not available on ${h.size}s`;
  if (mod.requires === 'shield' && !h.shield) return 'Requires shields';
  if (mod.requires === 'omniShield' && h.shield?.type !== 'omni') return 'Requires an omni shield';
  if (mod.requires === 'missileSlot' && !h.slots.some((s) => slotAccepts(s.type).includes('missile'))) return 'Requires a missile slot';
  const clash = (mod.incompatible ?? []).find((i) => installed.includes(i) || h.builtInMods.includes(i));
  if (clash) return `Incompatible with ${hullmod(clash).name}`;
  return null;
}

export function opUsed(l: Loadout): number {
  const h = hullDef(l.hullId);
  let op = l.vents + l.capacitors;
  for (const w of Object.values(l.weapons)) if (w) op += weapon(w).op;
  for (const m of l.hullmods) op += hullmodCost(hullmod(m), h);
  return op;
}

/** Every rule violation in a loadout. Empty array means it is legal. */
export function validateLoadout(l: Loadout): string[] {
  const h = hullDef(l.hullId);
  const errors: string[] = [];
  for (const [slotId, w] of Object.entries(l.weapons)) {
    const slot = h.slots.find((s) => s.id === slotId);
    if (!slot) {
      errors.push(`Unknown slot ${slotId}`);
      continue;
    }
    if (w) {
      const why = slotIncompatibility(slot, weapon(w));
      if (why) errors.push(`${slotId}: ${why}`);
    }
  }
  for (const m of l.hullmods) {
    const why = hullmodIncompatibility(hullmod(m), h, l.hullmods.filter((x) => x !== m));
    if (why) errors.push(`${hullmod(m).name}: ${why}`);
  }
  if (new Set(l.hullmods).size !== l.hullmods.length) errors.push('Duplicate hullmod');
  const max = MAX_VENTS[h.size];
  if (l.vents < 0 || l.vents > max) errors.push(`Vents must be 0–${max}`);
  if (l.capacitors < 0 || l.capacitors > max) errors.push(`Capacitors must be 0–${max}`);
  const op = opUsed(l);
  if (op > h.ordnancePoints) errors.push(`Over budget: ${op}/${h.ordnancePoints} OP`);
  return errors;
}

export interface ShipStats {
  hull: HullDef;
  style: ShipStyle;
  opUsed: number;
  opMax: number;
  hitpoints: number;
  armor: number;
  fluxCapacity: number;
  fluxDissipation: number;
  shield: { type: 'omni' | 'front'; arc: number; efficiency: number; upkeep: number } | null;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  cargo: number;
  fuel: number;
  crew: [number, number];
  suppliesPerJump: number;
  fuelPerLY: number;
  jumpRange: number;
  dps: Record<DamageType, number> & { total: number };
  /** Flux generated per second with every weapon firing. */
  weaponFlux: number;
  /** Dissipation minus weapon flux: negative means weapons can't be fired forever. */
  fluxBalance: number;
  rangeMin: number;
  rangeMax: number;
  pointDefence: number;
  missiles: number;
  /** Hullmod multipliers on weapon range and missile rate of fire. */
  rangeMult: number;
  missileRofMult: number;
}

/** Effective stats of a loadout: hull base + vents/capacitors + hullmods + weapons. */
export function computeStats(l: Loadout): ShipStats {
  const h = hullDef(l.hullId);
  const si = sizeIndex(h);
  const base: Record<string, number> = {
    hitpoints: h.hitpoints,
    armor: h.armor,
    fluxCapacity: h.fluxCapacity + l.capacitors * CAPACITOR_FLUX,
    fluxDissipation: h.fluxDissipation + l.vents * VENT_DISSIPATION,
    shieldEfficiency: h.shield?.efficiency ?? 0,
    shieldArc: h.shield?.arc ?? 0,
    maxSpeed: h.maxSpeed,
    accel: h.accel,
    turnRate: h.turnRate,
    cargo: h.cargo,
    fuel: h.fuel,
    suppliesPerJump: h.suppliesPerJump,
    fuelPerLY: h.fuelPerLY,
    jumpRange: h.jumpRange,
    'range.all': 1,
    'rof.missile': 1,
  };
  let shieldType = h.shield?.type ?? null;
  const mods = [...h.builtInMods, ...l.hullmods].map(hullmod);
  // Additions first, then multipliers, so ordering of mods never matters.
  for (const m of mods)
    for (const e of m.effects) {
      if (e.add !== undefined) base[e.stat] = (base[e.stat] ?? 0) + (Array.isArray(e.add) ? e.add[si] : e.add);
      if (e.set && e.stat === 'shieldType' && shieldType) shieldType = e.set as 'omni' | 'front';
    }
  for (const m of mods) for (const e of m.effects) if (e.mult !== undefined) base[e.stat] = (base[e.stat] ?? 0) * e.mult;

  const dps = { kinetic: 0, he: 0, energy: 0, frag: 0, total: 0 };
  let weaponFlux = 0;
  let rangeMin = Infinity;
  let rangeMax = 0;
  let pd = 0;
  let missiles = 0;
  for (const id of Object.values(l.weapons)) {
    if (!id) continue;
    const w = weapon(id);
    const rof = w.rof * (w.type === 'missile' ? base['rof.missile'] : 1);
    const d = w.kind === 'beam' ? w.damage : w.damage * rof;
    dps[w.damageType] += d;
    dps.total += d;
    weaponFlux += w.kind === 'beam' ? w.flux : w.flux * rof;
    const range = w.range * base['range.all'];
    rangeMin = Math.min(rangeMin, range);
    rangeMax = Math.max(rangeMax, range);
    if (w.pd) pd++;
    if (w.type === 'missile') missiles++;
  }
  const shield = h.shield && shieldType
    ? { type: shieldType, arc: Math.min(360, Math.max(30, base.shieldArc)), efficiency: base.shieldEfficiency, upkeep: h.shield.upkeep }
    : null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    hull: h,
    style: h.style,
    opUsed: opUsed(l),
    opMax: h.ordnancePoints,
    hitpoints: Math.round(base.hitpoints),
    armor: Math.round(base.armor),
    fluxCapacity: Math.round(base.fluxCapacity),
    fluxDissipation: Math.round(base.fluxDissipation),
    shield,
    maxSpeed: Math.round(base.maxSpeed),
    accel: round(base.accel),
    turnRate: round(base.turnRate),
    cargo: Math.round(base.cargo),
    fuel: Math.round(base.fuel),
    crew: h.crew,
    suppliesPerJump: round(base.suppliesPerJump),
    fuelPerLY: round(base.fuelPerLY),
    jumpRange: round(base.jumpRange),
    dps: { kinetic: round(dps.kinetic), he: round(dps.he), energy: round(dps.energy), frag: round(dps.frag), total: round(dps.total) },
    weaponFlux: round(weaponFlux),
    fluxBalance: round(base.fluxDissipation - weaponFlux),
    rangeMin: rangeMin === Infinity ? 0 : Math.round(rangeMin),
    rangeMax: Math.round(rangeMax),
    pointDefence: pd,
    missiles,
    rangeMult: base['range.all'],
    missileRofMult: base['rof.missile'],
  };
}

export function defaultLoadout(hullId: string): Loadout {
  const h = hullDef(hullId);
  const weapons: Record<string, string | null> = {};
  for (const s of h.slots) weapons[s.id] = h.defaultLoadout.weapons[s.id] ?? null;
  return { hullId, weapons, hullmods: [...h.defaultLoadout.hullmods], vents: h.defaultLoadout.vents, capacitors: h.defaultLoadout.capacitors };
}

export function emptyLoadout(hullId: string): Loadout {
  const h = hullDef(hullId);
  return { hullId, weapons: Object.fromEntries(h.slots.map((s) => [s.id, null])), hullmods: [], vents: 0, capacitors: 0 };
}

/** Deep copy (loadouts are edited in the refit screen). */
export function cloneLoadout(l: Loadout): Loadout {
  return { ...l, weapons: { ...l.weapons }, hullmods: [...l.hullmods] };
}

/** Weapons that can legally go in a slot, best value first. */
export function compatibleWeapons(slot: SlotDef): WeaponDef[] {
  return WEAPONS.filter((w) => !slotIncompatibility(slot, w));
}

/**
 * Reasonable automatic fit: fill the biggest slots first with the best
 * DPS-per-OP weapon that still leaves room, keep some PD, then spend the rest
 * on vents until weapons are flux-neutral, and capacitors with what's left.
 */
export function autofit(hullId: string, keepHullmods: string[] = []): Loadout {
  const h = hullDef(hullId);
  const l = emptyLoadout(hullId);
  l.hullmods = [...keepHullmods];
  const slots = [...h.slots].sort((a, b) => SIZE_RANK[b.size] - SIZE_RANK[a.size] || a.t - b.t);
  // Keep roughly a third of the budget for weapons-to-flux balance.
  const weaponBudget = h.ordnancePoints - opUsed(l) - Math.round(h.ordnancePoints * 0.22);
  let spent = 0;
  let pdCount = 0;
  for (const slot of slots) {
    const remainingSlots = slots.length - slots.indexOf(slot) - 1;
    const options = compatibleWeapons(slot)
      .filter((w) => spent + w.op + remainingSlots * 3 <= weaponBudget)
      .map((w) => {
        const dps = w.kind === 'beam' ? w.damage : w.damage * w.rof;
        let score = (dps / w.op) * (0.6 + w.range / 2000) * (w.size === slot.size ? 1.25 : 1);
        if (w.pd && pdCount < 2 && slot.size === 'S') score *= 2.2;
        return { w, score };
      })
      .sort((a, b) => b.score - a.score);
    const pick = options[0]?.w;
    if (pick) {
      l.weapons[slot.id] = pick.id;
      spent += pick.op;
      if (pick.pd) pdCount++;
    }
  }
  const max = MAX_VENTS[h.size];
  while (opUsed(l) < h.ordnancePoints && l.vents < max && computeStats(l).fluxBalance < 0) l.vents++;
  while (opUsed(l) < h.ordnancePoints && l.capacitors < max) l.capacitors++;
  while (opUsed(l) < h.ordnancePoints && l.vents < max) l.vents++;
  return l;
}
