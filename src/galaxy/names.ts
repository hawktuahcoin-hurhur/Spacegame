import { Rng } from '../core/rng';

const ONSETS = ['k', 'v', 'th', 'r', 's', 'z', 'm', 'n', 'l', 'dr', 'kr', 'tr', 'sh', 'h', 'b', 'p', 'g', 'x', 'st', 'br', 'c', 'y', 'f', 'd', 't', 'j', 'ph', 'vr'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'a', 'ai', 'ia', 'y', 'eo', 'au'];
const CODAS = ['', '', '', '', 'n', 'r', 's', 'l', 'th', 'x', 'm', 'k', 'rn', 'st', 'nd', 'ss'];
const SUFFIXES = [' Prime', ' Major', ' Minor', '-7', ' Reach', ' Deep', '-9', ' Cluster'];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const BAD = /[aeiouy]{3,}|[^aeiouy]{4,}|(.)\1\1|yy|^y[^aeiou]|q(?!u)/;

/** Pronounceable procedural name of 2–3 syllables. */
export function generateName(rng: Rng, minSyl = 2, maxSyl = 3): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const syllables = rng.int(minSyl, maxSyl);
    let name = '';
    for (let i = 0; i < syllables; i++) {
      const onset = i === 0 ? (rng.next() < 0.85 ? rng.pick(ONSETS) : '') : rng.pick(ONSETS);
      const coda = i === syllables - 1 ? rng.pick(CODAS) : rng.next() < 0.2 ? rng.pick(CODAS) : '';
      name += onset + rng.pick(VOWELS) + coda;
    }
    if (!BAD.test(name) && name.length >= 4 && name.length <= 10) return capitalize(name);
  }
  return capitalize(rng.pick(ONSETS) + rng.pick(VOWELS) + rng.pick(ONSETS) + 'a');
}

export function generateSystemName(rng: Rng): string {
  return generateName(rng, 2, 3) + (rng.next() < 0.25 ? rng.pick(SUFFIXES) : '');
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];

export function romanNumeral(n: number): string {
  return ROMAN[n - 1] ?? String(n);
}

const STATION_SUFFIXES = ['Highport', 'Exchange', 'Orbital', 'Station', 'Anchorage', 'Concourse', 'Waypoint', 'Spire'];

export function generateStationName(rng: Rng, planetName: string): string {
  return rng.next() < 0.5 ? `${planetName} ${rng.pick(STATION_SUFFIXES)}` : `${generateName(rng, 2, 2)} ${rng.pick(STATION_SUFFIXES)}`;
}
