import {
  assetKey,
  type AssetId,
  type PreparedOperation,
} from "@ewallet/domain";
// Spending from a contract's own holdings does not reserve the owner's tokens.
export function operationDebits(operation: PreparedOperation) {
  const amounts = new Map<string, bigint>();
  const native: AssetId = {
    networkId: operation.intent.networkId,
    standard: "native",
    reference: "native",
  };
  amounts.set(assetKey(native), BigInt(operation.fee.maximum));
  if (
    ["send", "nft-transfer", "deposit", "swap", "bridge"].includes(
      operation.intent.kind,
    )
  ) {
    const key = assetKey(operation.intent.asset);
    amounts.set(
      key,
      (amounts.get(key) ?? 0n) + BigInt(operation.intent.amount),
    );
  }
  return amounts;
}
export function sumDebits(operations: PreparedOperation[]) {
  const amounts = new Map<string, bigint>();
  for (const operation of operations)
    for (const [key, raw] of operationDebits(operation))
      amounts.set(key, (amounts.get(key) ?? 0n) + raw);
  return amounts;
}
