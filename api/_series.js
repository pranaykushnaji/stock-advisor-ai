// Preserve date alignment when a provider has a null close or volume bar. Filtering each array
// independently shifts later values onto the wrong dates and corrupts RVOL/money-flow signals.
export function alignCloseVolume(closes = [], volumes = []) {
  const outClose = [], outVolume = [];
  const n = Math.min(closes.length, volumes.length);
  for (let i = 0; i < n; i++) {
    if (closes[i] == null || volumes[i] == null || closes[i] === '' || volumes[i] === '') continue;
    const c = Number(closes[i]), v = Number(volumes[i]);
    if (!Number.isFinite(c) || !Number.isFinite(v) || c <= 0 || v < 0) continue;
    outClose.push(c);
    outVolume.push(v);
  }
  return { closes: outClose, volumes: outVolume };
}
