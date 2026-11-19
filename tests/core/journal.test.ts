import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { OperationJournal } from "../../packages/wallet-core/src/journal";
import { VaultStore } from "../../packages/wallet-core/src/storage";
import { operationFixture } from "../helpers/operation";
it("journals the expected identifier before broadcast and resumes uncertainty without a second signing transition", async () => {
  const op = operationFixture();
  const store = new VaultStore("local", `journal-${crypto.randomUUID()}`);
  const journal = new OperationJournal(store);
  await journal.create(op);
  await journal.transition(op.id, "review_ready", "awaiting_approval");
  await journal.transition(op.id, "awaiting_approval", "signing");
  await expect(journal.transition(op.id, "signing", "signed")).rejects.toThrow(
    "identifier",
  );
  await journal.transition(op.id, "signing", "signed", {
    expectedIdentifier: "fixture-expected-hash",
    signedBytesBase64: btoa("synthetic signed-byte fixture; not a transaction"),
  });
  const afterRestart = new OperationJournal(store);
  expect((await afterRestart.get(op.id))?.expectedIdentifier).toBe(
    "fixture-expected-hash",
  );
  await afterRestart.transition(op.id, "signed", "submission_unknown");
  await expect(
    afterRestart.transition(op.id, "submission_unknown", "signing"),
  ).rejects.toThrow("state changed");
  await afterRestart.transition(op.id, "submission_unknown", "submitted");
  await afterRestart.transition(op.id, "submitted", "included");
  await afterRestart.observe(op.id,'fixture-expected-hash',{state:'confirmed',height:'100',fee:'2345',blockHash:'block-a'});
  await afterRestart.transition(op.id, "included", "confirmed");
  expect((await new OperationJournal(store).get(op.id))?.observation?.fee).toBe('2345');
  await afterRestart.observe(op.id,'fixture-expected-hash',{state:'included',height:'101',fee:'2345',blockHash:'block-b'});
  expect((await afterRestart.get(op.id))?.reorged).toBe(true);
  await afterRestart.transition(op.id, "confirmed", "orphaned");
  await afterRestart.transition(op.id, "orphaned", "included");
  await afterRestart.transition(op.id, "included", "finalized");
  expect((await afterRestart.get(op.id))?.signedBytesBase64).toBeNull();
  await store.close();
});
