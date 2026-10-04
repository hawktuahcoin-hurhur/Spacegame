/**
 * Ship systems: the one special ability each hull has (F in combat). Effects
 * are stat modifiers while active plus an optional one-shot action; the AI
 * decides when to use them from the `use` hint.
 */
export interface SystemMods {
  speed?: number;
  accel?: number;
  turn?: number;
  /** Multiplier on armour/hull damage taken. */
  damageTaken?: number;
  /** Multiplier on shield flux per point of damage. */
  shieldFlux?: number;
  rof?: number;
  energyDamage?: number;
  /** Multiplier on weapon flux cost. */
  weaponFlux?: number;
  dissipation?: number;
  noFire?: boolean;
  noShield?: boolean;
  /** Burn: thrust forward at full power regardless of throttle, little turning. */
  burn?: boolean;
  /** Untouchable (phase skimmer dash). */
  phased?: boolean;
}

export type SystemUse = 'gapclose' | 'defend' | 'offence' | 'manoeuvre' | 'flares' | 'reload' | 'dash';

export interface ShipSystemDef {
  id: string;
  name: string;
  description: string;
  duration: number;
  cooldown: number;
  /** Charges that regenerate one per cooldown (default 1). */
  charges?: number;
  /** Flux generated on activation as a fraction of capacity. */
  fluxCost: number;
  mods: SystemMods;
  use: SystemUse;
  /** One-shot action on activation. */
  action?: 'flares' | 'reload' | 'dash';
}

export const SHIP_SYSTEMS: Record<string, ShipSystemDef> = {
  'Burn Drive': {
    id: 'burn_drive',
    name: 'Burn Drive',
    description: 'Straight-line thrust at triple speed. Hard to turn while burning.',
    duration: 3,
    cooldown: 10,
    fluxCost: 0,
    mods: { speed: 3, accel: 4, turn: 0.25, burn: true, noFire: true },
    use: 'gapclose',
  },
  'Phase Skimmer': {
    id: 'phase_skimmer',
    name: 'Phase Skimmer',
    description: 'A short phase-space blink: dash ahead, untouchable for a moment.',
    duration: 0.35,
    cooldown: 7,
    charges: 3,
    fluxCost: 0.04,
    mods: { phased: true, noFire: true, noShield: true },
    use: 'dash',
    action: 'dash',
  },
  'Flare Launcher': {
    id: 'flare_launcher',
    name: 'Flare Launcher',
    description: 'Fires decoy flares that pull guided missiles off course.',
    duration: 0.5,
    cooldown: 12,
    charges: 2,
    fluxCost: 0,
    mods: {},
    use: 'flares',
    action: 'flares',
  },
  'Missile Autoloader': {
    id: 'missile_autoloader',
    name: 'Missile Autoloader',
    description: 'Reloads every missile launcher with half a magazine.',
    duration: 1,
    cooldown: 30,
    charges: 2,
    fluxCost: 0,
    mods: {},
    use: 'reload',
    action: 'reload',
  },
  'Damper Field': {
    id: 'damper_field',
    name: 'Damper Field',
    description: 'Cuts armour and hull damage by 60% for five seconds.',
    duration: 5,
    cooldown: 16,
    fluxCost: 0.05,
    mods: { damageTaken: 0.4, speed: 0.7 },
    use: 'defend',
  },
  'High Energy Focus': {
    id: 'high_energy_focus',
    name: 'High Energy Focus',
    description: '+50% energy weapon damage and a third less weapon flux for six seconds.',
    duration: 6,
    cooldown: 18,
    fluxCost: 0.05,
    mods: { energyDamage: 1.5, weaponFlux: 0.67 },
    use: 'offence',
  },
  'Maneuvering Jets': {
    id: 'maneuvering_jets',
    name: 'Maneuvering Jets',
    description: 'Thrusters at overload: +50% speed, much faster turning and acceleration.',
    duration: 4,
    cooldown: 10,
    fluxCost: 0.03,
    mods: { speed: 1.5, accel: 2.5, turn: 2 },
    use: 'manoeuvre',
  },
  'Plasma Burn': {
    id: 'plasma_burn',
    name: 'Plasma Burn',
    description: 'A violent two-second sprint at triple speed.',
    duration: 2,
    cooldown: 12,
    fluxCost: 0.04,
    mods: { speed: 3, accel: 6, turn: 0.4, burn: true },
    use: 'gapclose',
  },
  'Emergency Burn': {
    id: 'emergency_burn',
    name: 'Emergency Burn',
    description: 'Overdrives the engines: +60% speed for six seconds, at a flux cost.',
    duration: 6,
    cooldown: 25,
    fluxCost: 0.12,
    mods: { speed: 1.6, accel: 1.8 },
    use: 'manoeuvre',
  },
  'Fortress Shield': {
    id: 'fortress_shield',
    name: 'Fortress Shield',
    description: 'Shields take 90% less flux, but weapons cannot fire.',
    duration: 7,
    cooldown: 20,
    fluxCost: 0,
    mods: { shieldFlux: 0.1, noFire: true, speed: 0.5 },
    use: 'defend',
  },
  'Temporal Shell': {
    id: 'temporal_shell',
    name: 'Temporal Shell',
    description: 'Time runs faster aboard: double rate of fire and dissipation, +50% speed.',
    duration: 5,
    cooldown: 20,
    fluxCost: 0.06,
    mods: { rof: 2, dissipation: 2, speed: 1.5, turn: 1.5 },
    use: 'offence',
  },
};

export function shipSystem(name: string): ShipSystemDef {
  return SHIP_SYSTEMS[name] ?? SHIP_SYSTEMS['Maneuvering Jets'];
}
