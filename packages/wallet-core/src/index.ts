export { WalletCore } from "./core";
export { VaultStore } from "./storage";
export { ApprovalLedger } from "./approvals";
export {
  envelopeSchema,
  parseEnvelope,
  seal,
  unseal,
  type VaultEnvelope,
  type VaultSecret,
} from "./vault";
export {
  derivePublic,
  importSecret,
  initialAccounts,
  createSecret,
  recoveryWords,
} from "./derivation";
