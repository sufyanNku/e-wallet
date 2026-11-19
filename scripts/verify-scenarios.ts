import "./report-paths.ts";
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const names=['pending-evm','replacement-evm','reverted-evm','reorg-evm','rpc-outage','relayer-timeout'],checks:Array<{scenario:string;startedAt:string;completedAt:string;exitCode:number}>=[];
for(const name of names){const startedAt=new Date().toISOString(),code=await new Promise<number>((resolve,reject)=>{const child=spawn('pnpm',['scenario','--',name],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});checks.push({scenario:name,startedAt,completedAt:new Date().toISOString(),exitCode:code});await writeFile('.local/reports/integration/scenario-verification.json',JSON.stringify({checks},null,2));if(code)throw new Error('Scenario failed: '+name);}
