// NSE announcement timestamps are commonly "06-Aug-2026 14:59:48" in IST. JavaScript's
// Date.parse is inconsistent for that format, especially after replacing the space with "T".
// Parse it explicitly and return a real UTC epoch. ISO timestamps remain supported.
const MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export function parseNseDateMs(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const month = MONTH[m[2].toLowerCase()];
    if (month == null) return null;
    const utc = Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +(m[6] || 0)) - IST_OFFSET_MS;
    return Number.isFinite(utc) ? utc : null;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

export function istDateTimeToUtcMs(ymd, time = '00:00:00') {
  const parsed = Date.parse(`${ymd}T${time}+05:30`);
  return Number.isFinite(parsed) ? parsed : null;
}
