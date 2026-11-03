// Public reference-data fetch only. Prints JSON; never uses a token or writes trade data.
import { CONSTITUENT_SOURCES, parseConstituents, buildResearchUniverse } from '../research/coverage.js';
import { NSE_INSTRUMENTS_URL } from '../api/_upstox-market-data.js';
import fs from 'node:fs';

async function download(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'StockAdvisor-Research/1.0', Accept: 'application/json,text/csv,*/*' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Public reference source HTTP ${r.status}`);
  return r;
}
const lists = Object.fromEntries(await Promise.all(Object.entries(CONSTITUENT_SOURCES).map(async ([key, url]) => {
  const rows = parseConstituents(await (await download(url)).text());
  const minimum = { broad: 450, mid: 140, small: 230 }[key];
  if (rows.length < minimum) throw new Error(`${key}: incomplete official list (${rows.length})`);
  return [key, rows];
})));
const bytes = new Uint8Array(await (await download(NSE_INSTRUMENTS_URL)).arrayBuffer());
const text = bytes[0] === 0x1f && bytes[1] === 0x8b
  ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  : new TextDecoder().decode(bytes);
const manifest=buildResearchUniverse({ ...lists, instruments: JSON.parse(text),
  fetchedAt: new Date().toISOString(), sources: { ...CONSTITUENT_SOURCES, instruments: NSE_INSTRUMENTS_URL } });
if(process.argv.includes('--refresh')){
  // Generated public reference artifact; never a trade or credential file.
  fs.writeFileSync(new URL('../research/universe.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({status:'registry_refreshed',...manifest.summary}));
}else console.log(JSON.stringify(manifest,null,2));
