import {
  WalletError,
  preparedOperationSchema,
  type PreparedOperation,
} from "@ewallet/domain";
export class ApprovalLedger {
  private operations = new Map<
    string,
    {
      operation: PreparedOperation;
      state: "awaiting_approval" | "approved" | "consumed" | "rejected";
      session: string;
    }
  >();
  constructor(
    private session = crypto.randomUUID(),
    private clock = () => Date.now(),
  ) {}
  register(input: PreparedOperation) {
    const operation = preparedOperationSchema.parse(structuredClone(input));
    if (this.operations.has(operation.id) || this.operations.size >= 100)
      throw new WalletError(
        "REQUEST_LIMIT",
        "Too many pending operations. Lock and unlock to start a new session.",
      );
    this.operations.set(operation.id, {
      operation,
      state: "awaiting_approval",
      session: this.session,
    });
    return structuredClone(operation);
  }
  review(id: string) {
    const r = this.require(id);
    return structuredClone(r.operation);
  }
  private require(id: string) {
    const r = this.operations.get(id);
    if (!r || r.session !== this.session)
      throw new WalletError(
        "APPROVAL_MISSING",
        "This request belongs to another session or was cancelled.",
      );
    if (this.clock() > r.operation.expiresAt)
      throw new WalletError(
        "APPROVAL_EXPIRED",
        "This review expired. Prepare and review again.",
      );
    return r;
  }
  approve(id: string, digest: string, accountId: string, networkId: string) {
    const r = this.require(id);
    if (r.state !== "awaiting_approval")
      throw new WalletError(
        "APPROVAL_USED",
        "This request has already been approved or rejected.",
      );
    if (
      digest !== r.operation.digest ||
      accountId !== r.operation.intent.accountId ||
      networkId !== r.operation.intent.networkId
    )
      throw new WalletError(
        "APPROVAL_CHANGED",
        "The account, network or operation changed. Review again.",
      );
    r.state = "approved";
  }
  consume(id: string) {
    const r = this.require(id);
    if (r.state !== "approved")
      throw new WalletError(
        "APPROVAL_REQUIRED",
        "Explicit, one-use approval is required.",
      );
    r.state = "consumed";
    return structuredClone(r.operation);
  }
  reject(id: string) {
    const r = this.operations.get(id);
    if (r && r.state !== "consumed") r.state = "rejected";
  }
  clear() {
    this.operations.clear();
    this.session = crypto.randomUUID();
  }
  status(id: string) {
    return this.operations.get(id)?.state ?? "unknown";
  }
}
