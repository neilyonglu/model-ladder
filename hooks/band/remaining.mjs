// Time until a usage window resets, rounded to the nearest value in its largest unit: 4h34m -> 5h, 59m40s -> 1h.
export const roundSpan = (ms) => {
  if (ms < 60000) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : '1m' }
  if (ms < 3600000) { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : '1h' }
  if (ms < 86400000) { const h = Math.round(ms / 3600000); return h < 24 ? `${h}h` : '1d' }
  return `${Math.round(ms / 86400000)}d`
}
