import {JsonRpcProvider,type JsonRpcPayload,type JsonRpcResult} from 'ethers';
import {proxyRpc} from '@ewallet/config/rpc';
export class WalletRpcProvider extends JsonRpcProvider{
 constructor(readonly profileId:string){super(undefined,Number(profileId.split(':')[1]),{staticNetwork:true,batchMaxCount:1,cacheTimeout:0});}
 override async _send(payload:JsonRpcPayload|JsonRpcPayload[]):Promise<JsonRpcResult[]>{const results:JsonRpcResult[]=[];for(const request of Array.isArray(payload)?payload:[payload]){const body=await proxyRpc(this.profileId,{...request,params:request.params as unknown[]});results.push(body as JsonRpcResult);}return results;}
}
