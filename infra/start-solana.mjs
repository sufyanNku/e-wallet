import {networkInterfaces} from 'node:os';
import {spawn} from 'node:child_process';
const address=Object.values(networkInterfaces()).flat().find(a=>a&&a.family==='IPv4'&&!a.internal)?.address;
if(!address)throw new Error('No container IPv4 address available');
const child=spawn('solana-test-validator',['--bind-address',address,...process.argv.slice(2)],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.once('error',()=>{process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
