import { WalletError } from "@ewallet/domain";
let session: Promise<{ csrfToken: string; expiresAt: string }> | null = null;
async function establish() {
  const response = await fetch("/api/v1/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new WalletError(
      "WATCH_SESSION",
      "Unable to establish a public RPC session.",
      true,
    );
  const body = (await response.json()) as {
    data?: { csrfToken: string; expiresAt: string };
  };
  if (typeof body.data?.csrfToken !== "string")
    throw new WalletError("WATCH_SESSION", "Invalid public RPC session.");
  return body.data;
}
export async function proxyRpc(
  networkId: string,
  request: {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params: unknown[];
  },
) {
  if (!session)
    session = establish().catch((error) => {
      session = null;
      throw error;
    });
  const auth = await session;
  if (Date.parse(auth.expiresAt) <= Date.now()) {
    session = null;
    throw new WalletError(
      "WATCH_SESSION",
      "Public RPC session expired. Refresh before reviewing.",
      true,
    );
  }
  let response: Response;
  try {
    response = await fetch("/api/v1/rpc/" + encodeURIComponent(networkId), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": auth.csrfToken,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new WalletError(
      "RPC_UNAVAILABLE",
      "Network request timed out or is disconnected.",
      true,
    );
  }
  if (response.status === 403) {
    session = null;
    throw new WalletError(
      "WATCH_SESSION",
      "Public RPC session changed. Refresh and review again.",
      true,
    );
  }
  if (!response.ok)
    throw new WalletError(
      "RPC_UNAVAILABLE",
      "The selected network is unavailable.",
      true,
    );
  const body = (await response.json()) as {
    data?: {
      id: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: string };
    };
  };
  if (!body.data || body.data.id !== request.id)
    throw new WalletError("RPC_RESPONSE", "Invalid network response.");
  return body.data;
}
export async function nodeRpc(
  networkId: string,
  method: string,
  params: unknown[] = [],
) {
  const response = await proxyRpc(networkId, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params,
  });
  if (response.error)
    throw new WalletError(
      "RPC_EXECUTION",
      "The node rejected the operation. Review its supported parameters.",
      true,
    );
  return response.result;
}
export async function bitcoinWatchRequest(
  method: "watch" | "utxos" | "address",
  payload: unknown,
) {
  if (!session)
    session = establish().catch((error) => {
      session = null;
      throw error;
    });
  const auth = await session;
  const response = await fetch("/api/v1/bitcoin/" + method, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": auth.csrfToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 403) {
    session = null;
    throw new WalletError(
      "WATCH_SESSION",
      "Re-establish the watch session before continuing.",
      true,
    );
  }
  if (!response.ok)
    throw new WalletError(
      "BITCOIN_UNAVAILABLE",
      "The regtest watch is unavailable. Check the local node and watch-only wallet.",
      true,
    );
  const result = (await response.json()) as { data: unknown };
  return result.data;
}
async function publicApi(path:string,method:'GET'|'POST',payload?:unknown){
 if(!session)session=establish().catch(error=>{session=null;throw error;});const auth=await session;
 const response=await fetch(path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrfToken},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(10000)});
 if(response.status===403){session=null;throw new WalletError('WATCH_SESSION','Public watch session changed. Refresh to reconnect.',true);}if(!response.ok)throw new WalletError('PUBLIC_DATA_UNAVAILABLE','Public data is temporarily unavailable.',true);return(await response.json()as{data:unknown}).data;
}
export function registerAddressWatch(networkId:string,address:string){return publicApi('/api/v1/watch','POST',{networkId,address});}
export function indexedActivity(watchId:string,cursor='0'){return publicApi('/api/v1/activity?'+new URLSearchParams({watchId,cursor,limit:'50'}),'GET');}
export function requestAssetMetadata(assetKey:string,allowRemote:boolean){return publicApi('/api/v1/metadata/request','POST',{assetKey,allowRemote});}

export function indexedNotifications(watchId:string){return publicApi('/api/v1/notifications?'+new URLSearchParams({watchId}),'GET');}
