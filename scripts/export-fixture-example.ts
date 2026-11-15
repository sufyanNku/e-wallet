import { MockWalletGateway, bob } from "../apps/wallet/src/mock-gateway";
import {
  preparedOperationSchema,
  transactionRecordSchema,
} from "@ewallet/domain";
import { writeFile } from "node:fs/promises";
const g = new MockWalletGateway();
g.loadSample();
const s = g.getSnapshot();
const operation = preparedOperationSchema.parse(
  await g.prepare({
    requestId: "sample-public-request",
    accountId: s.selectedAccountId,
    networkId: s.networkId,
    kind: "send",
    recipient: bob,
    asset: s.balances[0].asset,
    amount: "1",
  }),
);
const record = transactionRecordSchema.parse(
  await g.approve(operation.id, operation.digest),
);
await writeFile(
  "artifacts/phase-01/serialized-example.json",
  JSON.stringify({ source: "fixture", operation, record }, null, 2) + "\n",
);
