// api/_market-calendar.js
// Single source of truth for "is NSE open today?" — used by both crons.
// IST-based, independent of the server's UTC clock. ESM to match the repo.
//
// Weekend-falling 2026 holidays are intentionally omitted from the list below
// (the weekday checks already cover them). Nov 8 Muhurat is a special session;
// treated as closed for automation.

const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
]);

// Current IST calendar day + weekday, derived via the same timezone shift the
// rest of the codebase uses (Date.now() + 5.5h) so behavior matches todayIST().
export function nowIST(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  const ymd = ist.toISOString().slice(0, 10);
  const dow = ist.getUTCDay(); // 0=Sun .. 6=Sat, in IST wall-clock terms
  return { ymd, dow };
}

// Core guard. Unknown years fail CLOSED: missing a trading day is safer than placing orders on
// an exchange holiday. Add the next official NSE calendar before year-end.
export function marketStatus(date = new Date()) {
  const { ymd, dow } = nowIST(date);
  if (dow === 0) return { open: false, reason: 'weekend:Sunday' };
  if (dow === 6) return { open: false, reason: 'weekend:Saturday' };
  const year = ymd.slice(0, 4);
  if (year !== '2026') return { open: false, reason: `holiday-table-missing:${year}:failing-closed` };
  if (NSE_HOLIDAYS_2026.has(ymd)) return { open: false, reason: `holiday:${ymd}` };
  return { open: true, reason: 'trading-day' };
}

export function isMarketDay(date = new Date()) {
  return marketStatus(date).open;
}
