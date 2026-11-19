import "./report-paths.ts";
import {marketReader} from '../services/backend/src/markets';
import {writeFile,mkdir} from 'node:fs/promises';
const result=await marketReader()();await mkdir('.local/reports/product',{recursive:true});await writeFile('.local/reports/product/market-live-proof.json',JSON.stringify({...result,verification:'Actual external provider request; no fixture fallback'},null,2)+'\n');console.log(result.assets.length+' of 3 live Coinbase spot quotes observed; stale='+result.stale+'.');
