/** Player preferences, kept per browser in localStorage. */
export interface Settings {
  /** 'aim': the ship flies where you look. 'classic': mouse moves a virtual joystick. */
  controls: 'aim' | 'classic';
  invertY: boolean;
  /** Multiplier on mouse sensitivity (0.25–3). */
  sensitivity: number;
}

const KEY = 'spacegame:settings';
const DEFAULTS: Settings = { controls: 'aim', invertY: false, sensitivity: 1 };

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      controls: raw.controls === 'classic' ? 'classic' : 'aim',
      invertY: raw.invertY === true,
      sensitivity: typeof raw.sensitivity === 'number' && raw.sensitivity >= 0.25 && raw.sensitivity <= 3 ? raw.sensitivity : 1,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked (private mode): settings just won't persist.
  }
}
