// Read-only sources -> isolated estimated replay on stdout, never the account.
import {loadReplaySession} from '../research/replay-input.js';
import {replayPaperSession} from '../research/session-replay.js';
const date=process.argv[2],ref=process.argv[3]||'origin/main';
if(!date)throw Error('Supply YYYY-MM-DD and optional git ref');
const input=await loadReplaySession(date,ref),result=replayPaperSession(input);
result.source=input.source;
console.log(JSON.stringify(result,null,2));
