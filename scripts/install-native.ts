import {mkdir,readFile,writeFile,copyFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),cache='.local/downloads';await mkdir(cache,{recursive:true});
const assets=[
  {name:'agave-4.4.1.tar.bz2',url:'https://github.com/anza-xyz/agave/releases/download/v4.4.1/solana-release-x86_64-unknown-linux-gnu.tar.bz2',sha256:'5b0f0fc7e4eedace05f6455de00aa1f2f3d1642068f1e8d50760ba49112c3941'},
  {name:'bitcoin-32.1-x86_64-linux-gnu.tar.gz',url:'https://bitcoincore.org/bin/bitcoin-core-32.1/bitcoin-32.1-x86_64-linux-gnu.tar.gz',sha256:'61545c17c3120fb7412f896d248b11993af04ec8817aad3649c55b2afb044963'},
];
async function download(url:string,name:string){const path=`${cache}/${name}`;try{return await readFile(path);}catch{/* A verified cached download can be reused offline. */}const response=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw new Error(`Download failed: ${url} (${response.status})`);const length=Number(response.headers.get('content-length')??0);if(length>200000000)throw new Error('Download exceeds 200 MB');const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>200000000)throw new Error('Download exceeds 200 MB');await writeFile(path,bytes);return bytes;}
await Promise.all(assets.map(async asset=>{const bytes=await download(asset.url,asset.name);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error(`Checksum mismatch for ${asset.name}`);}));
await download('https://bitcoincore.org/bin/bitcoin-core-32.1/SHA256SUMS','bitcoin-SHA256SUMS');await download('https://bitcoincore.org/bin/bitcoin-core-32.1/SHA256SUMS.asc','bitcoin-SHA256SUMS.asc');await download('https://raw.githubusercontent.com/bitcoin-core/guix.sigs/main/builder-keys/fanquake.gpg','fanquake.gpg');
await mkdir('.local/gpg',{recursive:true,mode:0o700});await chmod('.local/gpg',0o700);await run('gpg',['--homedir','.local/gpg','--batch','--import',`${cache}/fanquake.gpg`]);let verification='';try{verification=(await run('gpg',['--homedir','.local/gpg','--batch','--status-fd','1','--verify',`${cache}/bitcoin-SHA256SUMS.asc`,`${cache}/bitcoin-SHA256SUMS`])).stdout;}catch(error){if(error&&typeof error==='object'&&'stdout'in error&&typeof error.stdout==='string')verification=error.stdout;}
if(!verification.split('\n').some(line=>line.includes('[GNUPG:] VALIDSIG')&&line.includes('E777299FC265DD04793070EB944D35F9AC3DB76A')))throw new Error('Bitcoin checksum list lacks a valid signature by the pinned trusted primary key');
const sums=await readFile(`${cache}/bitcoin-SHA256SUMS`,'utf8');if(!sums.split('\n').some(line=>line.startsWith(assets[1].sha256)&&line.endsWith(assets[1].name)))throw new Error('Signed Bitcoin checksum list does not match the pinned archive');
await mkdir('.local/native',{recursive:true});for(const asset of assets)await run('tar',['-xf',`${cache}/${asset.name}`,'-C','.local/native','--no-same-owner']);
const context='.local/image-context/native';await mkdir(context,{recursive:true});const files={'solana-test-validator':'.local/native/solana-release/bin/solana-test-validator',solana:'.local/native/solana-release/bin/solana','spl-token':'.local/native/solana-release/bin/spl-token',bitcoind:'.local/native/bitcoin-32.1/bin/bitcoind','bitcoin-cli':'.local/native/bitcoin-32.1/bin/bitcoin-cli'};
const hashes:Record<string,string>={};for(const [name,path] of Object.entries(files)){await copyFile(path,`${context}/${name}`);await chmod(`${context}/${name}`,0o755);hashes[name]=createHash('sha256').update(await readFile(path)).digest('hex');}await writeFile('.local/image-context/sha256.json',JSON.stringify(hashes));
await copyFile('infra/start-solana.mjs','.local/image-context/start-solana.mjs');
console.log('Pinned Agave 4.4.1 and Bitcoin Core 32.1 verified; Docker build context prepared.');
