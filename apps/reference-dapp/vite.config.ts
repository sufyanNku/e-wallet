import {referenceApi} from './reference-api';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react(),referenceApi()],server:{host:'127.0.0.1',port:5174,strictPort:true,headers:{'Cross-Origin-Opener-Policy':'unsafe-none','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:8787; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"}},build:{outDir:'dist',sourcemap:false}});
