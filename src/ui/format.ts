/** Human-friendly distance: m → km → Mm → Gm. */
export function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (a < 1000) return `${a.toFixed(0)} m`;
  if (a < 1e6) return `${(a / 1000).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0)} km`;
  if (a < 1e9) return `${(a / 1e6).toFixed(a < 1e7 ? 2 : 1)} Mm`;
  return `${(a / 1e9).toFixed(2)} Gm`;
}

export function formatSpeed(ms: number): { value: string; unit: string } {
  if (ms < 1000) return { value: ms.toFixed(0), unit: 'm/s' };
  if (ms < 1e6) return { value: (ms / 1000).toFixed(ms < 1e4 ? 2 : 1), unit: 'km/s' };
  return { value: (ms / 1e6).toFixed(2), unit: 'Mm/s' };
}

export function formatDuration(s: number): string {
  if (!isFinite(s) || s < 0) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, '0')}m`;
}

export function formatTemp(k: number): string {
  return `${Math.round(k - 273.15)} °C`;
}
