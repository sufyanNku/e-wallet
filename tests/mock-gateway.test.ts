import { describe, it, expect } from "vitest";
import {
  MockWalletGateway,
  bob,
  sampleWords,
} from "../apps/wallet/src/mock-gateway";
import { assetKey, type TransactionIntent } from "@ewallet/domain";
function ready() {
  const g = new MockWalletGateway();
  g.loadSample();
  return g;
}
function intent(
  g: MockWalletGateway,
  amount = "100000000000000000",
): TransactionIntent {
  const s = g.getSnapshot();
  return {
    requestId: crypto.randomUUID(),
    accountId: s.selectedAccountId,
    networkId: s.networkId,
    kind: "send",
    recipient: bob,
    asset: s.balances[0].asset,
    amount,
  };
}
describe("mock workflow and operation boundaries", () => {
  it("completes randomized sample backup and clears lock state", async () => {
    const g = new MockWalletGateway();
    const result = await g.create("a sample password", "a sample password");
    expect(new Set(result.challenge).size).toBe(3);
    await expect(
      g.finishBackup(["wrong", "wrong", "wrong"], true),
    ).rejects.toThrow();
    await g.finishBackup(
      result.challenge.map((i) => sampleWords[i]),
      true,
    );
    expect(g.getSnapshot().locked).toBe(false);
    g.lock();
    await expect(g.prepare(intent(g))).rejects.toThrow("Unlock");
    await g.unlock("a sample password");
    expect(g.getSnapshot().locked).toBe(false);
  });
  it("never accepts arbitrary recovery input in mock mode", async () => {
    const g = new MockWalletGateway();
    await expect(
      g.importSample(
        "abandon ".repeat(12),
        "sample password",
        "sample password",
      ),
    ).rejects.toThrow("not supported");
    expect(g.getSnapshot().initialized).toBe(false);
  });
  it("signs no keys and applies exact balance/fee deltas once", async () => {
    const g = ready(),
      before = BigInt(g.getSnapshot().balances[0].raw);
    const op = await g.prepare(intent(g));
    const tx = await g.approve(op.id, op.digest);
    expect(tx.source).toBe("fixture");
    expect(BigInt(g.getSnapshot().balances[0].raw)).toBe(
      before - BigInt(op.intent.amount) - BigInt(op.fee.estimated),
    );
    await expect(g.approve(op.id, op.digest)).rejects.toThrow("consumed");
  });
  it("does not accept a caller-mutated prepared object", async () => {
    const g = ready();
    const op = await g.prepare(intent(g));
    op.intent.amount = "900000000000000000000";
    await expect(g.approve(op.id, "modified")).rejects.toThrow("changed");
    const tx = await g.approve(op.id, op.digest);
    expect(tx.intent.amount).toBe("100000000000000000");
  });
  it("blocks expired, rejected and network-changed reviews", async () => {
    const g = ready(),
      op = await g.prepare(intent(g));
    g.selectNetwork("eip155:84532");
    await expect(g.approve(op.id, op.digest)).rejects.toThrow("changed");
    g.selectNetwork("eip155:31337");
    const rejected = await g.prepare(intent(g));
    g.reject(rejected.id);
    await expect(g.approve(rejected.id, rejected.digest)).rejects.toThrow();
    const stale = await g.prepare(intent(g));
    const realNow = Date.now;
    Date.now = () => stale.expiresAt + 1;
    try {
      await expect(g.approve(stale.id, stale.digest)).rejects.toThrow(
        "expired",
      );
    } finally {
      Date.now = realNow;
    }
  });
  it("handles insufficient balance, wrong-network and disconnected states", async () => {
    const g = ready();
    await expect(
      g.prepare(intent(g, "99999999999999999999999")),
    ).rejects.toThrow("exceeds");
    g.setScenario("low-fee");
    await expect(g.prepare(intent(g))).rejects.toThrow();
    g.setScenario("wrong-network");
    await expect(g.prepare(intent(g))).rejects.toThrow("changed");
    g.setScenario("rpc-offline");
    await expect(g.refresh()).rejects.toThrow("disconnected");
  });
  it("isolates account/network fixtures, hidden tokens and contacts", async () => {
    const g = ready(),
      key = assetKey(g.getSnapshot().balances[0].asset);
    g.hideAsset(key, true);
    expect(g.getSnapshot().balances[0].hidden).toBe(true);
    g.selectNetwork("eip155:84532");
    expect(g.getSnapshot().balances[0].hidden).toBe(false);
    g.selectNetwork("eip155:31337");
    expect(g.getSnapshot().balances[0].hidden).toBe(true);
    g.saveContact({
      id: "new",
      name: "Counterparty",
      networkId: "eip155:31337",
      address: bob,
    });
    g.deleteContact("new");
    expect(g.getSnapshot().contacts.some((c) => c.id === "new")).toBe(false);
  });
  it("requires two owner approvals and respects locked vault positions", async () => {
    const g = ready(),
      s = g.getSnapshot(),
      asset = s.balances.find((b) => b.symbol === "dUSDC")!.asset;
    await expect(
      g.prepare({
        ...intent(g, "50000000"),
        kind: "execute",
        asset,
        parameters: { proposalId: "proposal-1" },
      }),
    ).rejects.toThrow("two distinct");
    await expect(
      g.prepare({
        ...intent(g, "100000000"),
        kind: "withdraw",
        asset,
        parameters: { positionId: "position-1" },
      }),
    ).rejects.toThrow("locked");
  });
  it("expires quotes and limits slippage", async () => {
    const g = ready();
    const q = await g.quote("100", "50");
    expect(BigInt(q.output)).toBeGreaterThan(99n * 10n ** 18n);
    expect(BigInt(q.minimum)).toBeLessThan(BigInt(q.output));
    await expect(g.quote("100", "501")).rejects.toThrow("5%");
    g.setScenario("expired-quote");
    expect((await g.quote("100", "50")).expiresAt).toBeLessThan(Date.now());
  });
  it("reserves pending payments and reconciles each balance delta exactly once", async () => {
    const g = ready();
    g.setScenario("pending");
    const before = g.getSnapshot().balances[0].raw;
    for (let i = 0; i < 2; i++) {
      const op = await g.prepare(intent(g));
      await g.approve(op.id, op.digest);
    }
    expect(g.getSnapshot().balances[0].raw).toBe(before);
    expect(BigInt(g.getSnapshot().balances[0].reserved)).toBeGreaterThan(0n);
    await g.refresh();
    const after = g.getSnapshot().balances[0].raw;
    expect(BigInt(after)).toBeLessThan(BigInt(before));
    expect(g.getSnapshot().balances[0].reserved).toBe("0");
    await g.refresh();
    expect(g.getSnapshot().balances[0].raw).toBe(after);
  });
  it("covers sample empty/loading/stale, rejection, and actual reverted states honestly", async () => {
    const g = ready();
    g.setScenario("empty");
    expect(g.getSnapshot().balances).toEqual([]);
    g.setScenario("loading");
    await g.refresh();
    g.setScenario("stale");
    expect(g.getSnapshot().balances.every((b) => b.stale)).toBe(true);
    await g.refresh();
    expect(g.getSnapshot().balances.every((b) => !b.stale)).toBe(true);
    g.setScenario("rejected");
    const op = await g.prepare(intent(g));
    await expect(g.approve(op.id, op.digest)).rejects.toThrow("rejected");
    g.setScenario("reverted");
    const before = g.getSnapshot().balances[0].raw;
    const rev = await g.prepare(intent(g));
    expect((await g.approve(rev.id, rev.digest)).state).toBe("reverted");
    expect(g.getSnapshot().balances[0].raw).toBe(before);
  });
});
