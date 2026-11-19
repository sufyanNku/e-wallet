import "./report-paths.ts";
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {JsonRpcProvider,Contract} from 'ethers';
import {roots,seedEvm} from './seed-evm';
import {seedSolana} from './seed-solana';
import {seedBitcoin} from './seed-bitcoin';
import {bitcoinRpc} from '../services/backend/src/bitcoin-rpc';
import {rpcUpstream} from '../services/backend/src/rpc';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(){
 const evm=[];
 for(const chainId of [31337,31338]){const provider=new JsonRpcProvider('http://127.0.0.1:'+(chainId===31337?8545:8546),chainId,{staticNetwork:true,cacheTimeout:0}),manifest=JSON.parse(await readFile(`.local/state/deployments/eip155-${chainId}.json`,'utf8')),accounts=[];
  for(const[name,root]of Object.entries(roots)){const tokens=[];for(const asset of manifest.assets){const c=new Contract(asset.reference,asset.standard==='erc20'?['function balanceOf(address) view returns(uint256)']:asset.standard==='erc721'?['function ownerOf(uint256) view returns(address)']:['function balanceOf(address,uint256) view returns(uint256)'],provider);if(asset.standard==='erc20')tokens.push([asset.reference,String(await c.balanceOf(root.wallet.address))]);else if(asset.standard==='erc721')for(const id of asset.tokenIds)tokens.push([asset.reference,id,String(await c.ownerOf(id))]);else for(const id of asset.tokenIds)tokens.push([asset.reference,id,String(await c.balanceOf(root.wallet.address,id))]);}accounts.push({name,native:String(await provider.getBalance(root.wallet.address)),nonce:await provider.getTransactionCount(root.wallet.address),tokens});}
  evm.push({chainId,height:await provider.getBlockNumber(),accounts});provider.destroy();
 }
 const solManifest=JSON.parse(await readFile('.local/state/seed/solana-manifest.json','utf8')),solana=[];
 for(const[name,account]of Object.entries(solManifest.identities)as Array<[string,{address:string}]>){const rpc=async(method:string,params:unknown[])=>{const r=await rpcUpstream('http://127.0.0.1:8899',method,params,undefined,true)as{result:unknown;error?:unknown};if(r.error)throw new Error('Snapshot RPC failed');return r.result;};const balance=await rpc('getBalance',[account.address,{commitment:'confirmed'}])as{value:string},tokens=[];
  for(const program of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']){const result=await rpc('getTokenAccountsByOwner',[account.address,{programId:program},{encoding:'jsonParsed',commitment:'confirmed'}])as{value:Array<{pubkey:string;account:{data:unknown}}>};tokens.push(...result.value.map(a=>({address:a.pubkey,data:a.account.data})));}solana.push({name,balance:balance.value,tokens:tokens.sort((a,b)=>a.address.localeCompare(b.address))});
 }
 const outputs=await bitcoinRpc('listunspent',[0,9999999,[],true],'ewallet-watch')as Array<{txid:string;vout:string;amount:string;address:string}>,bitcoin={height:await bitcoinRpc('getblockcount'),outputs:outputs.map(u=>({txid:u.txid,vout:u.vout,amount:u.amount,address:u.address})).sort((a,b)=>(a.txid+':'+a.vout).localeCompare(b.txid+':'+b.vout))};
 return{evm,solana,bitcoin};
}
const before=await snapshot();await seedEvm();await seedSolana();await seedBitcoin();const after=await snapshot();
const checks=(['evm','solana','bitcoin']as const).map(family=>({family,before:digest(before[family]),after:digest(after[family]),unchanged:digest(before[family])===digest(after[family])}));await writeFile('.local/reports/chains/seed-idempotence.json',JSON.stringify({source:'node',observedAt:new Date().toISOString(),checks,solanaComparison:'Balances, token account states and delegates; continuously advancing empty slots are excluded.'},null,2));if(checks.some(c=>!c.unchanged))throw new Error('A seed rerun changed actual financial state.');console.log('All three chain families: seed rerun preserved balances, holdings and spendable outputs.');
