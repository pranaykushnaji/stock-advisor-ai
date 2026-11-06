import test from 'node:test';
import assert from 'node:assert/strict';
import {performanceSummary, tradeNetReturnPct, positionReturnPct, tradeNetAmount} from '../desk/performance.js';
import {simulationSession, simulationSuggestions, renderPositions, renderResults, summarizeLedger, escapeHTML, money, dateTime} from '../desk/desk.js';
import {renderPerformanceTracker,renderWorkspaceOverview,renderWorkspaceSystem} from '../desk/workspace.js';
const trade = (ticker,capital,net,extra={}) => ({id:ticker,ticker,investedAmount:capital,realizedNetPnl:net,realizedPnl:net+3,estimatedCostAmount:3,...extra});
const account = extra => ({cash:3300,contributions:3000,positions:[],trades:[trade('AAA',1000,100),trade('BBB',2000,200)],...extra});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('per-stock mean, weighted deployed return, and contribution return use distinct denominators',()=>{
  const p=performanceSummary(account({cash:3400,trades:[trade('AAA',1000,200),trade('BBB',2000,200)]}));
  close(p.averageClosedStockPct,15);close(p.deployedReturnPct,400/3000*100);close(p.accountReturnPct,400/3000*100);
  const funded=performanceSummary(account({contributions:10000,cash:10400,trades:[trade('AAA',1000,200),trade('BBB',2000,200)]}));
  close(funded.accountReturnPct,4);close(funded.deployedReturnPct,400/3000*100);
});
test('multiple legitimate entries are aggregated by stock before averaging; shares are not trade counts',()=>{
  const p=performanceSummary(account({trades:[trade('AAA',1000,100),trade('AAA',3000,-100,{id:'AAA-next-day'}),trade('BBB',2000,200)]}));
  close(p.averageClosedStockPct,5);assert.equal(p.closedStocks,2);assert.equal(p.closedCount,3);
});
test('open marks affect account P&L but not average closed-stock results; pending exit costs are not invented',()=>{
  const p=performanceSummary(account({cash:2300,positions:[{id:'CCC',ticker:'CCC',entryPrice:100,shares:10,currentPrice:110,investedAmount:1000}]}));
  close(p.accountPnl,400);close(p.accountReturnPct,400/3000*100);close(p.deployedReturnPct,10);close(p.averageClosedStockPct,10);
  close(positionReturnPct({entryPrice:100,currentPrice:110}),10);
});
test('missing capital, missing prices, zero capital and empty records never fabricate returns',()=>{
  assert.equal(performanceSummary(null),null);
  const empty=performanceSummary(account({cash:1000,contributions:1000,trades:[]}));
  assert.equal(empty.averageClosedStockPct,null);assert.equal(empty.deployedReturnPct,null);assert.equal(empty.accountReturnPct,0);
  assert.equal(performanceSummary(account({cash:0,contributions:0,trades:[]})).accountReturnPct,null);
  assert.equal(performanceSummary(account({positions:[{ticker:'X',entryPrice:100,shares:1}]})).accountReturnPct,null);
  assert.equal(tradeNetReturnPct({realizedNetPnl:100}),null);
});
test('synthetic/replay rows are excluded and contaminated or duplicate live accounts fail closed',()=>{
  for(const flag of ['synthetic','historicalReplay','excludeFromLiveStatistics','backdated','voided']){
    const p=performanceSummary(account({trades:[trade('AAA',1000,100),trade('REPLAY',1000,900,{[flag]:true})]}));
    close(p.averageClosedStockPct,10);assert.equal(p.accountReturnPct,null);assert.equal(p.excludedCount,1);
  }
  const duplicate=performanceSummary(account({trades:[trade('AAA',1000,100),trade('AAA',1000,100)]}));
  assert.equal(duplicate.duplicateCount,1);assert.equal(duplicate.accountReturnPct,null);assert.equal(duplicate.averageClosedStockPct,null);
  assert.equal(performanceSummary(account({positions:[{ticker:'A',id:'1'},{ticker:'A',id:'2'}]})).duplicateOpenTickers,1);
});
test('recorded net P&L is authoritative, costs support explicit sides, and invalid numbers stay unavailable',()=>{
  close(tradeNetAmount({realizedPnl:20,entryCost:1,exitCost:2}),17);
  close(tradeNetAmount({realizedNetPnl:16.99,realizedPnl:20,entryCost:1,exitCost:2}),16.99);
  assert.equal(positionReturnPct({entryPrice:0,currentPrice:100}),null);
  assert.equal(positionReturnPct({entryPrice:100,currentPrice:'110'}),null);
});
test('last saved session remains visible overnight and positions merge once per ticker',()=>{
  const sim={updatedAt:'2026-11-05T09:55:00Z',suggestions:[{ticker:'AAA',price:100}],scanHistory:{date:'2026-11-05',candidates:{BBB:{ticker:'BBB',lastPrice:110,firstPrice:100,observations:[]}}},positions:[{ticker:'AAA',date:'2026-11-05',addedAt:'2026-11-05T04:30:00Z',entryPrice:99,currentPrice:100,shares:5}]};
  const now=Date.parse('2026-11-06T00:00:00+05:30');
  assert.equal(simulationSession(sim,now),'2026-11-05');
  const rows=simulationSuggestions(sim,now);assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.ticker==='AAA').length,1);
  assert.equal(rows[0].shares,5);close(rows[0].entryReturnPct,(100/99-1)*100);assert.equal(rows[1].status,'Earlier watch');
});
test('percentage tracker and trade views label denominators, estimated costs and share quantities',()=>{
  const sim=account({updatedAt:'2026-11-05T09:55:00Z'}), fmt={e:escapeHTML,money,dateTime,percent:n=>n===null?'Not available':n.toFixed(2)+'%'};
  const html=renderPerformanceTracker(sim,fmt);
  assert.match(html,/Avg profit per closed stock/);assert.match(html,/Profit \/ capital invested/);assert.match(html,/Portfolio \/ contributions/);
  assert.match(html,/future exit fees, spread and slippage are not/);
  assert.match(renderResults(sim.trades,summarizeLedger(sim.trades,[])),/Net ₹ \/ return %/);
  assert.match(renderPositions([{ticker:'X',shares:5,entryPrice:100,currentPrice:105}],summarizeLedger([],[{shares:5,entryPrice:100,currentPrice:105}])),/each row is one entry/);
});

test('deployed one-share policy is visible even before a legacy saved scan migrates',()=>{
  const sim=account({updatedAt:'2026-11-05T09:55:00Z',strategyVersion:'paper-breakout-v1',days:{'2026-11-05':{invested:9819.15,buys:['A','B','C']}},positions:[{id:'OLD',ticker:'OLD',shares:5,entryPrice:100,currentPrice:100,investedAmount:500}]}),
    fmt={e:escapeHTML,money,dateTime,decimal:n=>String(n),percent:n=>n===null?'Not available':n.toFixed(2)+'%'};
  const html=renderWorkspaceSystem(sim,fmt);
  assert.match(html,/1 share per stock/);assert.match(html,/Existing multi-share positions keep their original quantities/);
  assert.match(html,/No count cap/);assert.doesNotMatch(html,/Daily investment left|<small> \/ 3/);
  assert.match(html,/paper-one-share-v2/);assert.match(html,/Last saved scan policy<\/dt><dd>paper-breakout-v1/);
});

test('homepage shows returns and recent picks without engine, rule or calculation clutter',()=>{
  const sim=account({updatedAt:'2026-11-05T09:55:00Z',positions:[{ticker:'PICK',id:'PICK',fullName:'Picked Company',addedAt:'2026-11-05T04:00:00Z',investedAmount:1000,entryPrice:100,currentPrice:110,shares:10,lastPriceUpdate:'2026-11-05T09:55:00Z'}]}),
    fmt={e:escapeHTML,money,dateTime,decimal:n=>String(n),percent:n=>n==null?'Not available':n.toFixed(2)+'%'};
  const html=renderWorkspaceOverview({sim,suggestions:[]},fmt);
  assert.match(html,/TOTAL RETURN/);assert.match(html,/Avg\. profit per closed stock/);assert.match(html,/Latest picks/);assert.match(html,/PICK/);
  assert.doesNotMatch(html,/Engine pulse|Scan activity|Discovery score|Strategy & safeguards|How returns are calculated|New-entry policy/);
  assert.match(html,/#results/);assert.match(html,/#positions/);
});

test('homepage retains urgent data checks and shows at most five unpurchased suggestions when no picks exist',()=>{
  const sim=account({updatedAt:'2026-11-05T09:55:00Z',trades:[],positions:[],discovery:{benchmark:{fresh:false}}}),
    fmt={e:escapeHTML,money,dateTime,decimal:n=>String(n),percent:n=>n==null?'Not available':n.toFixed(2)+'%'};
  const suggestions=Array.from({length:8},(_,i)=>({ticker:'WATCH'+i,name:'Example',discoveryScore:80-i,price:100,sinceFirstSeenPct:1}));
  const html=renderWorkspaceOverview({sim,suggestions},fmt);
  assert.match(html,/New entries paused/);assert.match(html,/Watching, not bought/);assert.match(html,/WATCH4/);assert.doesNotMatch(html,/WATCH5/);
  assert.match(html,/not trade P&L/);assert.match(html,/#system/);
});

test('past-session trades do not hide the current session watch list',()=>{
  const sim=account({updatedAt:'2026-11-06T04:00:00Z',trades:[trade('OLD',1000,100,{entryDate:'2026-11-05',addedAt:'2026-11-05T04:00:00Z'})]}),
    fmt={e:escapeHTML,money,dateTime,percent:n=>n==null?'Not available':n.toFixed(2)+'%'};
  const html=renderWorkspaceOverview({sim,suggestions:[{ticker:'NEW',price:100,name:'New idea'}]},fmt);
  assert.match(html,/Watching, not bought/);assert.match(html,/<h3>NEW<\/h3>/);assert.doesNotMatch(html,/<h3>OLD<\/h3>/);
});
