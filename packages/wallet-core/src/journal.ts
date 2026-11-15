import {
  WalletError,
  type PreparedOperation,
  type TransactionRecord,
} from "@ewallet/domain";
import { VaultStore } from "./storage";
type State = TransactionRecord["state"];
export type JournalEntry = {
  id: string;
  operation: PreparedOperation;
  state: State;
  expectedIdentifier: string | null;
  signedBytesBase64: string | null;
  updatedAt: string;
  revision: number;
  observation?: {
    state: State;
    height: string | null;
    fee: string | null;
    blockHash: string | null;
    observedAt: string;
  };
  reorged?: boolean;
};
const transitions: Partial<Record<State, State[]>> = {
  draft: ["review_ready", "rejected"],
  review_ready: ["awaiting_approval", "expired", "rejected"],
  awaiting_approval: ["signing", "rejected", "expired"],
  signing: ["signed", "rejected"],
  signed: ["submitted", "submission_unknown", "expired"],
  submitted: [
    "included",
    "submission_unknown",
    "dropped",
    "replaced",
    "reverted",
    "orphaned",
    "expired",
  ],
  submission_unknown: [
    "submitted",
    "included",
    "expired",
    "dropped",
    "replaced",
    "reverted",
    "orphaned",
  ],
  included: ["confirmed", "finalized", "reverted", "orphaned"],
  confirmed: ["finalized", "orphaned"],
  finalized: ["orphaned"],
  orphaned: [
    "submitted",
    "included",
    "submission_unknown",
    "dropped",
    "replaced",
  ],
};
export class OperationJournal {
  constructor(private store: VaultStore) {}
  async create(operation: PreparedOperation) {
    const requestKey =
      "request:" +
      operation.intent.networkId +
      ":" +
      operation.intent.accountId +
      ":" +
      (operation.intent.origin ?? "wallet") +
      ":" +
      operation.intent.requestId;
    await this.store.updateJournal<{ operationId: string }>(
      requestKey,
      (current) => {
        if (current)
          throw new WalletError(
            "DUPLICATE_INTENT",
            "This request was already prepared. Reconcile it instead of signing again.",
          );
        return { operationId: operation.id };
      },
    );
    return this.store.updateJournal<JournalEntry>(operation.id, (current) => {
      if (current)
        throw new WalletError(
          "JOURNAL_EXISTS",
          "An operation with this ID already exists. Reconcile it before retrying.",
        );
      return {
        id: operation.id,
        operation: structuredClone(operation),
        state: "review_ready",
        expectedIdentifier: null,
        signedBytesBase64: null,
        updatedAt: new Date().toISOString(),
        revision: 1,
      };
    });
  }
  async get(id: string) {
    return this.store.journal<JournalEntry>(id);
  }
  async entries() {
    return (await this.store.allJournal()).filter(
      (value): value is JournalEntry =>
        Boolean(
          value &&
          typeof value === "object" &&
          "operation" in value &&
          "expectedIdentifier" in value,
        ),
    );
  }
  async observe(
    id: string,
    identifier: string,
    observation: {
      state: State;
      height: string | null;
      fee: string | null;
      blockHash: string | null;
    },
  ) {
    return this.store.updateJournal<JournalEntry>(id, (current) => {
      if (!current || current.expectedIdentifier !== identifier)
        throw new WalletError(
          "JOURNAL_OBSERVATION",
          "Observation differs from the signed operation.",
        );
      const changed = Boolean(
        current.observation?.blockHash &&
        current.observation.blockHash !== observation.blockHash,
      );
      return {
        ...current,
        observation: { ...observation, observedAt: new Date().toISOString() },
        reorged: current.reorged || changed || observation.state === "orphaned",
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
    });
  }
  async transition(
    id: string,
    expected: State,
    next: State,
    patch: Pick<
      JournalEntry,
      "expectedIdentifier" | "signedBytesBase64"
    > | null = null,
  ) {
    return this.store.updateJournal<JournalEntry>(id, (current) => {
      if (
        !current ||
        current.state !== expected ||
        !transitions[expected]?.includes(next)
      )
        throw new WalletError(
          "JOURNAL_TRANSITION",
          "Operation state changed. Reconcile the existing request.",
        );
      if (
        next === "signed" &&
        (!patch?.expectedIdentifier ||
          !patch.signedBytesBase64 ||
          patch.signedBytesBase64.length > 262144)
      )
        throw new WalletError(
          "JOURNAL_SIGNED",
          "Journal the expected transaction identifier and bounded signed bytes before submission.",
        );
      if (patch && next !== "signed")
        throw new WalletError(
          "JOURNAL_IMMUTABLE",
          "Signed operation data cannot be replaced after review.",
        );
      const entry = {
        ...current,
        ...patch,
        state: next,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (
        [
          "finalized",
          "reverted",
          "dropped",
          "replaced",
          "expired",
          "rejected",
        ].includes(next)
      )
        entry.signedBytesBase64 = null;
      return entry;
    });
  }
}
