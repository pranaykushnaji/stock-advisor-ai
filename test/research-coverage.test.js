import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseConstituents, buildResearchUniverse, quoteBatches } from '../research/coverage.js';

const member = { symbol: 'ABC', name: 'Example', sector: 'Industry', isin: 'INE745G01043' };
const instrument = { trading_symbol: 'ABC', segment: 'NSE_EQ', instrument_type: 'EQ', isin: member.isin, instrument_key: `NSE_EQ|${member.isin}` };
const inputs = { broad: [member], mid: [member], small: [], instruments: [instrument], fetchedAt: '2026-11-03T17:00:00Z' };
test('official CSV supports quoted commas, escapes, CRLF and rejects malformed content', () => {
  assert.deepEqual(parseCsv('A,B\r\n"A, B","C""D"\r\n'), [['A','B'],['A, B','C"D']]);
  assert.throws(() => parseCsv('"bad'), /Unclosed/);
  assert.throws(() => parseConstituents('<html>blocked</html>'), /schema/);
});
test('reference registry maps exact NSE cash-equity identity and never enables production', () => {
  const r = buildResearchUniverse(inputs);
  assert.equal(r.summary.mapped, 1); assert.equal(r.members[0].marketCapBucket, 'mid');
  assert.equal(r.members[0].eligibleToTrade, false); assert.equal(r.productionEnabled, false);
  assert.equal(r.historicalMembershipAvailable, false);
});
test('wrong ISIN, ambiguous cash symbols, and derivatives are not silently mapped', () => {
  const wrong = { ...instrument, isin: 'INE591G01025', instrument_key: 'NSE_EQ|INE591G01025' };
  for (const instruments of [[wrong], [instrument, wrong], [{ ...instrument, segment: 'NSE_FO' }]]) {
    assert.equal(buildResearchUniverse({ ...inputs, instruments }).summary.mapped, 0);
  }
});
test('conflicting index identity and size membership fail closed', () => {
  assert.throws(() => buildResearchUniverse({ ...inputs, small: [member] }), /Conflicting/);
  assert.throws(() => buildResearchUniverse({ ...inputs, mid: [{ ...member, symbol: 'OTHER' }] }), /Conflicting/);
});
test('quote plans deduplicate and respect provider batch ceilings', () => {
  const members = Array.from({length: 501}, (_, i) => ({ instrumentKey: `key-${i}` }));
  assert.deepEqual(quoteBatches(members).map(b=>b.length), [250,250,1]);
  assert.throws(()=>quoteBatches(members, 501), /batch/);
});
