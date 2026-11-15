import toolbox from '@nomicfoundation/hardhat-toolbox-mocha-ethers';
import {defineConfig} from 'hardhat/config';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export default defineConfig({
  plugins:[toolbox],
  solidity:{version:'0.8.38',path:require.resolve('solc/soljson.js'),preferWasm:true,settings:{evmVersion:'paris',optimizer:{enabled:true,runs:200}}},
  networks:{
    localA:{type:'edr-simulated',chainType:'l1',chainId:31337,accounts:[],initialDate:'2026-11-13T12:00:00Z',loggingEnabled:false},
    localB:{type:'edr-simulated',chainType:'l1',chainId:31338,accounts:[],initialDate:'2026-11-13T12:00:00Z',loggingEnabled:false},
    testB:{type:'edr-simulated',chainType:'l1',chainId:31338},
  },
});
