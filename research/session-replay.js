// Counterfactual study only. NEVER imported by an execution endpoint or added to its ledger.
import { liveSimulationEntry } from "../api/_entry-research.js";
import {observeSetupExit,setupExitPolicy} from './setup-exits.js';
import {assessTradingSetups} from './trading-setups.js';
import { SIM_CONFIG, paperEntryAllocation } from "../api/_paper-simulation.js";
import {entryMarketContext,assessPaperEntry,researchCohort} from './entry-quality.js';
import {decisionEvidence} from './decision-evidence.js';
const round = (n) => Math.round(n * 100) / 100;
const lastCompleted = (rows, at) =>
  (rows || [])
    .filter(
      (r) => Date.parse(r[0]) + 60000 <= at && Date.parse(r[0]) % 60000 === 0,
    )
    .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))
    .at(-1);
export function replayPaperSession({
  date,
  scans,
  series,
  benchmark,
  generatedAt = new Date().toISOString(),
  config = SIM_CONFIG,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("Session date required");
  let cash = config.dailyInvestment??0,
    contributions = cash, invested = 0;
  const positions = [],
    trades = [],
    bought = new Set(),
    checks = [],
    seen = {};
  const assumedHalfSpreadBps = 15; // explicit 30bp spread scenario; historical book NOT observed
  for (const scan of [...scans].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  )) {
    const at = Date.parse(scan.at),
      m = new Date(at + 19800000),
      minute = m.getUTCHours() * 60 + m.getUTCMinutes();
    if (
      !Number.isFinite(at) ||
      m.toISOString().slice(0, 10) !== date ||
      minute < 555 ||
      minute >= 930
    )
      continue;
    const result = {
      at: scan.at,
      sourceCommit: scan.sourceCommit,
      bought: null,
      rejected: [],
      exits: [],
    };
    // Same five-minute sampling as live. No low/high-between-scans stop fills are invented.
    for (let i = positions.length - 1; i >= 0; i--) {
      const p = positions[i],
        bar = lastCompleted(series[p.ticker]?.candles, at);
      if (!bar || at - (Date.parse(bar[0]) + 60000) > 90000) {
        result.rejected.push({
          ticker: p.ticker,
          reasons: ["missing historical exit observation"],
        });
        continue;
      }
      const observedAt = new Date(Date.parse(bar[0]) + 60000).toISOString(),
        price = bar[4];
      const q = {
        symbol: p.ticker,
        instrumentKey: p.instrumentKey,
        price,
        bidPrice: price * (1 - assumedHalfSpreadBps / 10000),
        lastTradeAt: observedAt,
        responseAt: observedAt,
      };
      const exit = observeSetupExit(p, q, { nowMs: at });
      Object.assign(p, exit.state, {
        currentPrice: price,
        lastMarkedAt: observedAt,
      });
      if (!exit.decision && scan.negativeSymbols?.includes(p.ticker))
        exit.decision = {
          observedFillPrice: q.bidPrice,
          reason: "point-in-time official risk flag",
        };
      if (exit.decision) {
        const fill =
            exit.decision.observedFillPrice *
            (1 - config.exitSlippageBps / 10000),
          proceeds = round(fill * p.shares),
          fee = round((proceeds * config.costBpsPerSide) / 10000);
        const gross = round(proceeds - p.investedAmount),
          net = round(gross - p.entryCost - fee);
        trades.push({
          ...p,
          exitAt: observedAt,
          exitPrice: fill,
          exitReason: exit.decision.reason,
          realizedPnl: gross,
          realizedNetPnl: net,
          estimatedCostAmount: round(p.entryCost + fee),
        });
        cash = round(cash + proceeds - fee);
        positions.splice(i, 1);
        result.exits.push(p.ticker);
      }
    }
    const benchBar = lastCompleted(benchmark?.candles, at),
      benchFresh = benchBar && at - (Date.parse(benchBar[0]) + 60000) <= 90000;
    const benchChange =
      benchFresh && benchmark.previousClose > 0
        ? (benchBar[4] / benchmark.previousClose - 1) * 100
        : null;
    const marketContext=config.entryMode?entryMarketContext(benchmark?.candles,benchFresh?{
      instrumentKey:'NSE_INDEX|Nifty 50',price:benchBar[4],previousClose:benchmark.previousClose,
      responseAt:new Date(Date.parse(benchBar[0])+60000).toISOString()}:undefined, {now:new Date(at)}):null;
    for (const row of scan.suggestions || []) {
      if (!(row.price > 0)) continue;
      const r = seen[row.ticker] || {
        firstAt: row.observedAt,
        firstPrice: row.price,
        maxObservedPrice: row.price,
        minObservedPrice: row.price,
      };
      r.lastAt = row.observedAt;
      r.lastPrice = row.price;
      r.maxObservedPrice = Math.max(r.maxObservedPrice, row.price);
      r.minObservedPrice = Math.min(r.minObservedPrice, row.price);
      seen[row.ticker] = r;
      const reasons = [],
        history = series[row.ticker],
        reference = scan.dailyCache?.[row.ticker];
      if (bought.has(row.ticker)) continue;
      if (config.maxBuysPerDay!=null && bought.size >= config.maxBuysPerDay) {
        reasons.push("daily new-position limit");
      }
      if (config.maxOpenPositions!=null && positions.length >= config.maxOpenPositions)
        reasons.push("open-position cap");
      if (config.sectorLimit!==false && positions.some((p) => p.sector === row.sector))
        reasons.push("sector already represented");
      if (!scan.safetyReady)
        reasons.push("point-in-time safety snapshot unavailable");
      if (scan.negativeSymbols?.includes(row.ticker))
        reasons.push("point-in-time negative filing");
      if (benchChange == null)
        reasons.push("historical Nifty observation unavailable");
      else if (benchChange < -1) reasons.push("Nifty risk-off");
      if (!history?.candles?.length || !(history.previousClose > 0))
        reasons.push("historical company data unavailable");
      else if ((row.price / history.previousClose - 1) * 100 <= benchChange)
        reasons.push("not outperforming Nifty");
      if (
        !reference ||
        reference.asOf !== date ||
        reference.averageTurnoverCr < config.minimumAverageTurnoverCr
      )
        reasons.push("liquidity reference failed");
      if (!(reference?.ema20 > 0) || row.price <= reference.ema20)
        reasons.push("EMA20 confirmation failed");
      if (
        !Number.isFinite(Date.parse(row.observedAt)) ||
        at - Date.parse(row.observedAt) > 90000 ||
        Date.parse(row.observedAt) > at
      )
        reasons.push("archived price observation stale or future");
      // Only the original, timestamped shortlist is considered, not the day's winners.
      const fill = row.price * (1 + assumedHalfSpreadBps / 10000) * (1 + config.entrySlippageBps / 10000);
      const setupReview=config.setupMode&&history?.candles?assessTradingSetups({candles:history.candles,
        quote:{price:row.price,lastTradeAt:row.observedAt},reference,marketContext,research:row.research,
        now:new Date(at),fillPrice:fill,allowedTypes:config.allowedSetupTypes}):null;
      const assessment=config.setupMode?(setupReview?.assessment??{reasons:['no qualifying setup lane'],metrics:setupReview?.lanes[0]?.assessment.metrics??{},
        setup:{status:'no_setup',reason:'all setup lanes await confirmation'}}):config.entryMode&&history?.candles?assessPaperEntry({candles:history.candles,
        quote:{price:row.price,lastTradeAt:row.observedAt},reference,marketContext,now:new Date(at),mode:config.entryMode,fillPrice:fill}):null;
      const setup = assessment?.setup??(history?.candles
        ? liveSimulationEntry(
            history.candles,
            { price: row.price, lastTradeAt: row.observedAt },
            { now: new Date(at), regime: "neutral" },
          )
        : null);
      if(config.entryMode)reasons.push(...(assessment?.reasons||['entry momentum evidence unavailable']));
      if (setup?.status !== "setup")
        reasons.push(setup?.reason || "completed setup unavailable");
      const evidence=decisionEvidence({quote:{price:row.price,askPrice:row.price*(1+assumedHalfSpreadBps/10000),
        bidPrice:row.price*(1-assumedHalfSpreadBps/10000),spreadBps:assumedHalfSpreadBps*2,
        previousClose:history?.previousClose,lastTradeAt:row.observedAt},reference,setup,assessment,marketContext,
        benchmark:benchFresh?{price:benchBar[4],previousClose:benchmark.previousClose,responseAt:new Date(Date.parse(benchBar[0])+60000).toISOString()}:null,
        at:new Date(at),slippageBps:config.entrySlippageBps,requireMomentum:!!config.entryMode,
        requireAtr:config.setupMode&&config.exitMode==='setup-volatility',safetyReady:scan.safetyReady,
        quoteSource:'Estimated historical',dailySource:'Archived / retrospective',candleSource:'Historical completed candles',benchmarkSource:'Historical'});
      if(!evidence.readiness.ready)reasons.push('decision evidence incomplete: '+evidence.readiness.missingRequired.join(', '));
      if (reasons.length) {
        result.rejected.push({ ticker: row.ticker, reasons });
        continue;
      }
      const stop = setup.supportLevel * 0.999;
      const stopPct = (1 - stop / fill) * 100;
      if (stopPct < config.minStopPct || stopPct > config.maxStopPct) {
        result.rejected.push({
          ticker: row.ticker,
          reasons: ["structure stop outside policy band"],
        });
        continue;
      }
      let exitPolicy=null;
      if(config.setupMode){try{exitPolicy=setupExitPolicy(setup.setupType,{mode:config.exitMode??'baseline',entryPrice:fill,
        initialStopPrice:stop,atr14Pct:reference?.atr14Pct,costBps:config.costBpsPerSide*2});}
        catch{result.rejected.push({ticker:row.ticker,reasons:['required frozen setup exit inputs unavailable']});continue;}}
      const allocation=paperEntryAllocation({fill,stop,positions,cash,day:{invested},config});
      const {shares}=allocation;
      if (shares < 1) {
        result.rejected.push({
          ticker: row.ticker,
          reasons: [allocation.reason],
        });
        continue;
      }
      const amount=allocation.invested, cost=allocation.entryCost;
      const p = {
        id: `replay|${date}|${row.ticker}`,
        ticker: row.ticker,
        symbol: row.ticker,
        instrumentKey: `NSE_EQ|replay-${row.ticker}`,
        date,
        sector: row.sector,
        entryAt: row.observedAt,
        addedAt: row.observedAt,
        entryPrice: fill,
        observedReferencePrice: row.price,
        shares,
        investedAmount: amount,
        entryCost: cost,
        initialStopPrice: stop,
        peakPrice: fill,
        currentPrice: row.price,
        lastObservedAt: row.observedAt,
        modeledInitialRisk: allocation.modeledInitialRisk,
        setup,setupReview,setupType:setup.setupType??null,entryLane:setup.setupType??'experimental-consolidation',exitPolicy,
        entryAssessment:assessment,entryMarket:marketContext,decisionEvidence:evidence,
        research:row.research??null,researchCohort:researchCohort(row.research,new Date(at)),
        sourceCommit: scan.sourceCommit,
        historicalReplay: true,
        synthetic: true,
        executed: false,
        excludeFromLiveStatistics: true,
        executionConfidence:
          "ESTIMATED — historical bid/ask and execution bands not archived",
      };
      positions.push(p);
      bought.add(row.ticker);
      contributions=round(contributions+allocation.contribution);
      cash = round(cash + allocation.contribution - amount - cost);
      invested = round(invested + amount + cost);
      result.bought = row.ticker;
      break;
    }
    checks.push(result);
  }
  const gross = round(trades.reduce((s, t) => s + t.realizedPnl, 0)),
    net = round(trades.reduce((s, t) => s + t.realizedNetPnl, 0));
  return {
    schemaVersion: 1,
    mode: "historical-replay",
    date,
    generatedAt,
    asOf: checks.at(-1)?.at ?? null,
    strategyVersion: config.version,
    executionRuleVersion: config.executionRuleVersion,
    capital: contributions,
    fundingMode: config.fundingMode??'fixed-daily',
    config,
    cash,
    invested,
    positions,
    trades,
    checks,
    observations: seen,
    summary: {
      newPositions: bought.size,
      closedTrades: trades.length,
      openPositions: positions.length,
      realizedGross: gross,
      realizedNet: net,
      markedUnrealized: round(
        positions.reduce(
          (s, p) => s + (p.currentPrice - p.entryPrice) * p.shares,
          0,
        ),
      ),
    },
    assumptions: {
      halfSpreadBps: assumedHalfSpreadBps,
      slippageBpsPerSide: config.entrySlippageBps,
      costBpsPerSide: config.costBpsPerSide,
      candidateUniverse:
        "only original committed shortlists; not a complete hypothetical rediscovery",
      priceBasis:
        "entry reference = original saved price at its recorded time; exits = last completed one-minute close",
    },
    limitations: [
      "Counterfactual estimated scenario, NOT executed paper trades or certain historical fills.",
      "Historical bid/ask depth and execution-time circuit bands were not archived; exact live eligibility cannot be established.",
      "Discovery passed for archived candidates; later execution book/circuit checks remain unverified.",
      "Candles fetched retrospectively can contain provider revisions. Only completed, pre-decision bars are used.",
      "Retrospective candles are not a recovered Upstox order book. Cross-provider differences can affect setup signals.",
      "Previously observed pending signals can use modeled later candle closes; these are not saved executable quotes.",
      "No old live positions, contributions or performance statistics are overwritten.",
    ],
  };
}
