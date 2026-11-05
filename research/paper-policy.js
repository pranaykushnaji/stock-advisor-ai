// Public, versioned paper policy. Contains no credentials or network dependencies.
export const LEGACY_SIM_CONFIG = Object.freeze({version:'paper-breakout-v1',dailyInvestment:10000,
  executionRuleVersion:'five-minute-opening-v2',maxPositionInvestment:5000,maxBuysPerDay:3,maxOpenPositions:5,
  modeledRiskPerTrade:100,maxModeledOpenRisk:500,maxSpreadBps:30,minimumAverageTurnoverCr:10,
  minStopPct:0.5,maxStopPct:3,entrySlippageBps:5,exitSlippageBps:5,
  costBpsPerSide:15,noProgressSessions:3,maximumSessions:5});
// Notional paper funding is recorded as capital, never counted as profit.
export const SIM_CONFIG = Object.freeze({...LEGACY_SIM_CONFIG,version:'paper-one-share-v2',
  executionRuleVersion:'five-minute-one-share-v3',sharesPerEntry:1,
  dailyInvestment:null,maxPositionInvestment:null,maxBuysPerDay:null,maxOpenPositions:null,
  sectorLimit:false,fundingMode:'as-needed-paper-capital'});
