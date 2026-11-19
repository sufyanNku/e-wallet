import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {Plugin} from 'vite';
import {networkRpc} from '../../services/backend/src/node-rpc';
import {bitcoinRpc,bitcoinIdentity} from '../../services/backend/src/bitcoin-rpc';
import {bitcoinWatchSchema,deriveWatchAddress,satoshis,selectCoins,buildPsbt,type BitcoinUtxo} from '@ewallet/chain-bitcoin';
// Local development helper: fixed public reads and public fixture PSBTs only.
// This module is Vite-server code and is excluded from the browser bundle.
export function referenceApi():Plugin{return{name:'reference-public-fixtures',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(!req.url?.startsWith('/reference/'))return next();try{if(req.method!=='GET'||req.headers.host!=='127.0.0.1:5174')throw new Error('Denied');const url=new URL(req.url,'http://127.0.0.1:5174');let data:unknown;
 if(url.pathname==='/reference/solana/blockhash'){data=await networkRpc('solana:local','getLatestBlockhash',[{commitment:'confirmed'}]);}
 else if(url.pathname==='/reference/bitcoin/psbt'){
  const manifest=JSON.parse(await readFile(process.env.EWALLET_ISOLATED_BITCOIN_TEST==='1'?'.local/reports/chains/isolated-bitcoin-manifest.json':'.local/state/seed/bitcoin-manifest.json','utf8')),watches=z.array(bitcoinWatchSchema).parse(manifest.identities.alice),watch=watches.find(w=>deriveWatchAddress(w,0,0).address===url.searchParams.get('address'));if(!watch)throw new Error('Only the documented public Alice fixture is supported by this development helper.');await bitcoinIdentity();
  const derivations=[0,1].flatMap(branch=>Array.from({length:20},(_,index)=>deriveWatchAddress(watch,branch as 0|1,index))),outputs=z.array(z.object({txid:z.string(),vout:z.string(),address:z.string(),scriptPubKey:z.string(),amount:z.string(),confirmations:z.string()})).parse(await bitcoinRpc('listunspent',[1,9999999,derivations.map(d=>d.address)],'ewallet-watch')),utxos:BitcoinUtxo[]=[];
  for(const output of outputs){const d=derivations.find(d=>d.address===output.address)!;utxos.push({txid:output.txid,vout:Number(output.vout),address:output.address,scriptHex:output.scriptPubKey,value:satoshis(output.amount),confirmations:output.confirmations,path:d.path,change:d.change,addressIndex:d.addressIndex,rawTransaction:z.string().parse(await bitcoinRpc('getrawtransaction',[output.txid,false]))});}
  const bob=bitcoinWatchSchema.parse(manifest.identities.bob[0]),recipient=deriveWatchAddress(bob,0,0).address,changeIndex=0,selection=selectCoins(utxos,10000n,recipient,deriveWatchAddress(watch,1,changeIndex).address,watch.purpose,2n);data={psbt:buildPsbt(watch,selection,recipient,changeIndex).toBase64(),changeIndex,recipient,amount:'10000'};
 }else return next();res.statusCode=200;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({data}));
 }catch{res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Public local fixture data unavailable. Start and seed the selected local node.'}));}});}};}
