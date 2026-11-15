import { networkById } from "@ewallet/config";
import { rpcUpstream, validateRpc } from "./rpc";
import { bitcoinRpc } from "./bitcoin-rpc";
export class NetworkRpcError extends Error{constructor(readonly method:string,readonly executionReverted:boolean){super('Indexed RPC failed: '+method);}}
export async function networkRpc(
  networkId: string,
  method: string,
  params: unknown[] = [],
) {
  const profile = networkById(networkId);
  validateRpc(method, params, profile.family, profile.logRangeLimit);
  if (profile.family === "bitcoin") return bitcoinRpc(method, params);
  const endpoint =
    profile.id === "solana:local" &&
    process.env.EWALLET_ISOLATED_SOLANA_TEST === "1"
      ? "http://127.0.0.1:18899"
      : profile.rpcs[0];
  const result = (await rpcUpstream(
    endpoint,
    method,
    params,
    undefined,
    profile.family !== "evm",
  )) as { result?: unknown; error?: { code: number;message?:string } };
  if (result.error) throw new NetworkRpcError(method,method==='eth_call'&&[-32000,3].includes(Number(result.error.code))&&/revert/i.test(result.error.message??''));
  return result.result;
}
