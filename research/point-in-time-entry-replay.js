// Future scans can be replayed through the EXACT production transition, not a
// second approximation. This module never imports a write handler or broker API.
import {emptySimulation,transitionSimulation} from '../api/_paper-simulation.js';
import {readEntryEvidence} from './entry-evidence.js';
import {BASELINE_SIM_CONFIG,SIM_CONFIG} from './paper-policy.js';
import {ENTRY_VARIANTS} from './entry-quality.js';
import {entryCohortPerformance} from './entry-cohorts.js';
export function replayPointInTimeEntries(records,{scenarios=null}={}){
  const frames=[...new Map(records.filter(r=>Number.isFinite(Date.parse(r.updatedAt))&&r.entryEvidence?.at===r.updatedAt).map(r=>[r.updatedAt,r])).values()]
    .sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt));
  return {mode:'isolated-point-in-time-paper-study',status:frames.some(r=>readEntryEvidence(r.entryEvidence))?'evidence_available':'no_recorded_evidence',ordersExecuted:0,
    variants:(scenarios??ENTRY_VARIANTS.map(mode=>({mode,config:mode==='baseline'?BASELINE_SIM_CONFIG:{...SIM_CONFIG,entryMode:mode}}))).map(({mode,config})=>{
      let state=emptySimulation(),unavailableFrames=0;
      for(const r of frames){const market=readEntryEvidence(r.entryEvidence);if(!market){unavailableFrames++;continue;}
        state=transitionSimulation(state,market,{at:new Date(r.updatedAt),action:'scan',config}).state;
      }
      const cohorts=entryCohortPerformance(state);
      // Label even exact-logic hypothetical records. They never become account P&L.
      for(const p of [...state.positions,...state.trades])Object.assign(p,{synthetic:true,historicalReplay:true,executed:false,excludeFromLiveStatistics:true});
      return {mode,frames:frames.length,unavailableFrames,entryCohorts:cohorts,state};
    }),limitations:['Starts with an empty hypothetical portfolio; not the actual account.',
      'Actual saved provider quotes are used; unobserved alternative fills are not guaranteed.',
      'Missing candidate history or quote evidence prevents a trade/exit; no data is fabricated.',
      'Only recorded scan frames are compared, not a full historical discovery universe.']};
}
