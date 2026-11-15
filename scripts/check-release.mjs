import {readFile,readdir} from 'node:fs/promises';
const config=JSON.parse(await readFile('apps/wallet/dist/wallet-config.json','utf8'));const files=await readdir('apps/wallet/dist/assets');
const forbidden=['Fill designated sample words','Mock state scenario','Public vector-only test password','abandon abandon abandon','Load demo wallet'];
for(const file of files.filter(f=>f.endsWith('.js'))){const text=await readFile(`apps/wallet/dist/assets/${file}`,'utf8');for(const phrase of forbidden){if(text.includes(phrase))throw new Error(`Release includes test-only fixture/control: ${phrase}`);}}
if(config.mode==='mock')throw new Error('This release check requires a real wallet build.');
if(files.some(f=>f.startsWith('mock-gateway')))throw new Error('Fixture gateway was bundled into the real build.');
console.log('Real release boundary passed: no fixture gateway, test seed, sample credentials, or preview scenario controls.');
