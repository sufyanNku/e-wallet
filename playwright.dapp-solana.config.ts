import base from './playwright.dapp.config';
import {defineConfig} from '@playwright/test';
export default defineConfig({...base,testMatch:'solana.spec.ts',webServer:[{command:'pnpm serve:web',env:{EWALLET_ISOLATED_SOLANA_TEST:'1',PLAYWRIGHT_NO_COPY_PROMPT:'1'},url:'http://127.0.0.1:8787/api/v1/health',reuseExistingServer:false},{command:'pnpm dev:dapp',env:{EWALLET_ISOLATED_SOLANA_TEST:'1'},url:'http://127.0.0.1:5174',reuseExistingServer:false}],reporter:[['list'],['json',{outputFile:'artifacts/phase-04/dapp-solana-results.json'}]]});
