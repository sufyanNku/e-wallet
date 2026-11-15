import {
  prepareMessagePayload,
  signReviewedMessage,
  type MessagePayload,
} from "./message-signer";
import type { VaultSecret } from "./vault";
import { messageReviewSchema, type MessageReview } from "@ewallet/domain";
import { z } from "zod";
import { Interface, getAddress, MaxUint256 } from "ethers";
import {
  connectorMethods,
  parseConnectorRequest,
  assertConnectorOrigin,
  appPermissionSchema,
  WalletError,
  type AppPermission,
  type ConnectorRequest,
  type AccountRef,
  type TransactionIntent,
  type PreparedOperation,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import { abis } from "@ewallet/config/abis";
import { VaultStore } from "./storage";
export type DappContext = {
  origin: string;
  request: ConnectorRequest;
  expiresAt: number;
  grantId: string | null;
  preparedId: string | null;
  consumed: boolean;
};
export type DappWalletContext = { account: AccountRef; networkId: string };
export class DappSessions {
  private messages = new Map<
    string,
    { review: MessageReview; payload: MessagePayload }
  >();
  private channels = new Map<string, DappContext>();
  constructor(
    private store: VaultStore,
    private context: () => Promise<DappWalletContext>,
    private prepareIntent: (
      intent: TransactionIntent,
    ) => Promise<PreparedOperation>,
    private clock = () => Date.now(),
  ) {}
  clear() {
    this.channels.clear();
    this.messages.clear();
  }
  async permissions() {
    return z
      .array(appPermissionSchema)
      .max(100)
      .parse(await this.store.permissions());
  }
  async revoke(id: string) {
    const permission = (await this.permissions()).find((p) => p.id === id);
    if (permission)
      await this.store.savePermission({ ...permission, revoked: true });
  }
  async open(origin: string, input: unknown) {
    assertConnectorOrigin(origin);
    const request = parseConnectorRequest(input),
      now = this.clock();
    if (request.expiresAt <= now || request.expiresAt > now + 120000)
      throw new WalletError(
        "DAPP_EXPIRED",
        "The requesting site’s two-minute approval window expired.",
      );
    for (const [channel, context] of this.channels)
      if (context.expiresAt <= now) this.channels.delete(channel);
    if (this.channels.size >= 6)
      throw new WalletError(
        "REQUEST_LIMIT",
        "Resolve the existing site requests first.",
      );
    if (this.channels.has(request.channel))
      throw new WalletError(
        "DUPLICATE_REQUEST",
        "This approval channel is already in use.",
      );
    await this.store.updateJournal(
      "connector-request:" + origin + ":" + request.requestId,
      (current) => {
        if (current)
          throw new WalletError(
            "DUPLICATE_REQUEST",
            "This site request ID was already received. Start a fresh request.",
          );
        return {
          origin,
          requestId: request.requestId,
          method: request.method,
          receivedAt: new Date(now).toISOString(),
        };
      },
    );
    const context: DappContext = {
      origin,
      request: structuredClone(request),
      expiresAt: Math.min(request.expiresAt, now + 120000),
      grantId: null,
      preparedId: null,
      consumed: false,
    };
    this.channels.set(request.channel, context);
    return { origin, request: context.request };
  }
  require(channel: string) {
    const context = this.channels.get(channel);
    if (!context || context.expiresAt <= this.clock() || context.consumed)
      throw new WalletError(
        "DAPP_EXPIRED",
        "This channel expired or was consumed. Reopen approval from the site.",
      );
    return context;
  }
  requestedMethods(context: DappContext) {
    const raw = context.request.params[0],
      wanted =
        raw && typeof raw === "object" && "methods" in raw
          ? z.array(z.string().max(80)).max(20).parse(raw.methods)
          : [context.request.method];
    if (
      wanted.some(
        (method) =>
          !(
            connectorMethods[context.request.family] as readonly string[]
          ).includes(method),
      )
    )
      throw new WalletError(
        "UNSUPPORTED_METHOD",
        "The site requested unsupported permission methods.",
      );
    return Array.from(
      new Set([
        ...wanted,
        ...(context.request.family === "evm"
          ? ["eth_accounts", "eth_chainId"]
          : context.request.family === "solana"
            ? ["solana:accounts"]
            : ["bitcoin:getAccounts", "bitcoin:getNetwork"]),
      ]),
    );
  }
  async findGrant(channel: string) {
    const context = this.require(channel),
      { account, networkId } = await this.context();
    if (account.family !== context.request.family)
      throw new WalletError(
        "WRONG_NETWORK",
        "Select an account and network in the requested family.",
      );
    return (
      (await this.permissions()).find(
        (p) =>
          !p.revoked &&
          p.origin === context.origin &&
          p.family === context.request.family &&
          p.accounts.includes(account.id) &&
          p.networks.includes(networkId) &&
          Date.parse(p.expiresAt) > this.clock() &&
          p.methods.includes(context.request.method),
      ) ?? null
    );
  }
  async grant(channel: string) {
    const context = this.require(channel),
      { account, networkId } = await this.context();
    if (
      account.family !== context.request.family ||
      networkById(networkId).family !== context.request.family
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Select the requested family before sharing an account.",
      );
    const methods = this.requestedMethods(context),
      existing = (await this.permissions()).find(
        (p) =>
          p.origin === context.origin &&
          p.family === account.family &&
          !p.revoked,
      ),
      now = this.clock();
    const permission: AppPermission = {
      id: existing?.id ?? crypto.randomUUID(),
      origin: context.origin,
      family: account.family,
      accounts: Array.from(
        new Set([...(existing?.accounts ?? []), account.id]),
      ),
      networks: Array.from(new Set([...(existing?.networks ?? []), networkId])),
      methods: Array.from(new Set([...(existing?.methods ?? []), ...methods])),
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      revoked: false,
    };
    await this.store.savePermission(permission);
    context.grantId = permission.id;
    return permission;
  }
  async authorized(channel: string) {
    const context = this.require(channel),
      grant = await this.findGrant(channel);
    if (!grant)
      throw new WalletError(
        "DAPP_UNAUTHORIZED",
        "This origin has no current grant for the selected account, network and method.",
      );
    context.grantId = grant.id;
    return { context, grant, ...(await this.context()) };
  }
  async publicResult(channel: string) {
    const { context, grant, account, networkId } =
      await this.authorized(channel);
    if (
      ![
        "eth_requestAccounts",
        "eth_accounts",
        "eth_chainId",
        "solana:connect",
        "solana:accounts",
        "bitcoin:getAccounts",
        "bitcoin:getNetwork",
        "wallet_switchEthereumChain",
      ].includes(context.request.method)
    )
      throw new WalletError(
        "UNSUPPORTED_METHOD",
        "This request requires its own signing review.",
      );
    return {
      accounts: [account.address],
      networkId,
      expiresAt: grant.expiresAt,
      grantId: grant.id,
    };
  }
  async disconnect(channel: string) {
    const context = this.require(channel);
    for (const permission of await this.permissions())
      if (
        permission.origin === context.origin &&
        permission.family === context.request.family
      )
        await this.revoke(permission.id);
    context.consumed = true;
    return { disconnected: true };
  }
  async switchNetwork(channel: string) {
    const context = this.require(channel);
    if (
      context.request.method !== "wallet_switchEthereumChain" ||
      context.request.family !== "evm"
    )
      throw new WalletError(
        "UNSUPPORTED_METHOD",
        "Not a network switch request.",
      );
    const params = z
      .tuple([
        z.object({ chainId: z.string().regex(/^0x[0-9a-f]+$/i) }).strict(),
      ])
      .parse(context.request.params);
    return { context, chainId: BigInt(params[0].chainId).toString() };
  }
  async prepareExternal(
    channel: string,
    builder: (
      context: DappContext,
      account: AccountRef,
    ) => Promise<PreparedOperation>,
  ) {
    const { context, account } = await this.authorized(channel);
    const operation = await builder(context, account);
    context.preparedId = operation.id;
    return operation;
  }
  async prepareEvm(channel: string) {
    const { context, account, networkId } = await this.authorized(channel);
    if (context.request.method !== "eth_sendTransaction")
      throw new WalletError(
        "UNSUPPORTED_METHOD",
        "This is not a transaction request.",
      );
    const intent = decodeEvmDappIntent(context, account, networkId),
      operation = await this.prepareIntent(intent);
    context.preparedId = operation.id;
    return operation;
  }
  async prepareMessage(channel: string) {
    const { context, account, networkId } = await this.authorized(channel);
    if (
      !["personal_sign", "eth_signTypedData_v4", "solana:signMessage"].includes(
        context.request.method,
      )
    )
      throw new WalletError(
        "UNSUPPORTED_METHOD",
        "This is not a supported message request.",
      );
    const parsed = prepareMessagePayload(
        context.request.method as MessageReview["method"],
        context.request.params,
        account,
        networkId,
      ),
      id = crypto.randomUUID(),
      expiresAt = Math.min(context.expiresAt, this.clock() + 60000),
      serialized = JSON.stringify({
        origin: context.origin,
        requestId: context.request.requestId,
        channel,
        account: account.address,
        networkId,
        payload: parsed.payload,
        expiresAt,
      }),
      digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(serialized),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join(""),
      review = messageReviewSchema.parse({
        id,
        channel,
        origin: context.origin,
        accountAddress: account.address,
        networkId,
        method: context.request.method,
        digest,
        expiresAt,
        displayText: parsed.displayText,
        encoding: parsed.encoding,
        byteLength: parsed.byteLength,
        domain: parsed.domain,
      });
    this.messages.set(id, { review, payload: parsed.payload });
    context.preparedId = id;
    return review;
  }
  async signMessage(
    channel: string,
    id: string,
    digest: string,
    secret: VaultSecret,
  ) {
    const { context, account, networkId } = await this.requireOperation(
        channel,
        id,
      ),
      prepared = this.messages.get(id);
    if (
      !prepared ||
      prepared.review.digest !== digest ||
      prepared.review.accountAddress !== account.address ||
      prepared.review.networkId !== networkId ||
      prepared.review.expiresAt <= this.clock()
    )
      throw new WalletError(
        "APPROVAL_CHANGED",
        "Message review changed or expired.",
      );
    this.consume(channel);
    this.messages.delete(id);
    const signature = await signReviewedMessage(
      secret,
      account,
      prepared.payload,
    );
    return {
      signature,
      account: account.address,
      networkId,
      requestId: context.request.requestId,
    };
  }
  async requireOperation(channel: string, id: string) {
    const authorized = await this.authorized(channel);
    if (authorized.context.preparedId !== id)
      throw new WalletError(
        "APPROVAL_CHANGED",
        "This operation belongs to another channel or request.",
      );
    return authorized;
  }
  consume(channel: string) {
    const context = this.require(channel);
    context.consumed = true;
  }
}
export function decodeEvmDappIntent(
  context: DappContext,
  account: AccountRef,
  networkId: string,
): TransactionIntent {
  const profile = networkById(networkId);
  if (profile.family !== "evm")
    throw new WalletError("WRONG_NETWORK", "Select an EVM network.");
  const tx = z
    .object({
      from: z.string().optional(),
      to: z.string(),
      value: z
        .string()
        .regex(/^0x[0-9a-f]+$/i)
        .default("0x0"),
      data: z
        .string()
        .regex(/^0x(?:[0-9a-f]{2})*$/i)
        .max(50000)
        .default("0x"),
      chainId: z
        .string()
        .regex(/^0x[0-9a-f]+$/i)
        .optional(),
    })
    .strict()
    .parse(context.request.params[0]);
  if (
    (tx.from && getAddress(tx.from) !== getAddress(account.address)) ||
    (tx.chainId && BigInt(tx.chainId) !== BigInt(profile.identity))
  )
    throw new WalletError(
      "WRONG_NETWORK",
      "The requested sender or chain differs from the selected account.",
    );
  const canonical = (iface: Interface, name: string) => {
    const decoded = iface.decodeFunctionData(name, tx.data);
    if (
      iface.encodeFunctionData(name, decoded).toLowerCase() !==
      tx.data.toLowerCase()
    )
      throw new WalletError(
        "CALLDATA",
        "Noncanonical or trailing calldata is unsupported.",
      );
    return decoded;
  };
  let kind: TransactionIntent["kind"] = "send",
    recipient = getAddress(tx.to),
    amount = BigInt(tx.value),
    asset: TransactionIntent["asset"] = {
      networkId,
      standard: "native",
      reference: "native",
    };
  if (tx.data !== "0x") {
    if (amount !== 0n)
      throw new WalletError(
        "UNSUPPORTED_OPERATION",
        "Decoded token calls cannot also transfer native value.",
      );
    const selector = tx.data.slice(0, 10),
      token = new Interface(abis.DemoERC20),
      nft = new Interface(abis.DemoNFT721),
      multi = new Interface(abis.DemoNFT1155);
    if (selector === token.getFunction("transfer")!.selector) {
      const decoded = canonical(token, "transfer");
      recipient = getAddress(decoded[0]);
      amount = BigInt(decoded[1]);
      asset = {
        networkId,
        standard: "erc20",
        reference: getAddress(tx.to).toLowerCase(),
      };
    } else if (selector === token.getFunction("approve")!.selector) {
      const decoded = canonical(token, "approve");
      recipient = getAddress(decoded[0]);
      amount = BigInt(decoded[1]);
      if (amount === MaxUint256)
        throw new WalletError(
          "ALLOWANCE_POLICY",
          "Use an exact bounded allowance. Unlimited approvals are unsupported.",
        );
      kind = amount === 0n ? "revoke" : "approve";
      asset = {
        networkId,
        standard: "erc20",
        reference: getAddress(tx.to).toLowerCase(),
      };
    } else if (
      selector ===
      nft.getFunction("safeTransferFrom(address,address,uint256)")!.selector
    ) {
      const decoded = canonical(
        nft,
        "safeTransferFrom(address,address,uint256)",
      );
      if (getAddress(decoded[0]) !== getAddress(account.address))
        throw new WalletError(
          "OWNERSHIP",
          "NFT source differs from the authorized account.",
        );
      kind = "nft-transfer";
      recipient = getAddress(decoded[1]);
      amount = 1n;
      asset = {
        networkId,
        standard: "erc721",
        reference: getAddress(tx.to).toLowerCase(),
        tokenId: String(decoded[2]),
      };
    } else if (selector === multi.getFunction("safeTransferFrom")!.selector) {
      const decoded = canonical(multi, "safeTransferFrom");
      if (
        getAddress(decoded[0]) !== getAddress(account.address) ||
        decoded[4] !== "0x"
      )
        throw new WalletError(
          "UNSUPPORTED_OPERATION",
          "Only the authorized source and empty ERC-1155 receiver data are supported.",
        );
      kind = "nft-transfer";
      recipient = getAddress(decoded[1]);
      amount = BigInt(decoded[3]);
      asset = {
        networkId,
        standard: "erc1155",
        reference: getAddress(tx.to).toLowerCase(),
        tokenId: String(decoded[2]),
      };
    } else
      throw new WalletError(
        "UNSUPPORTED_METHOD",
        "Unknown or arbitrary calldata is not supported by this connector.",
      );
  }
  return {
    requestId: context.request.requestId,
    accountId: account.id,
    networkId,
    kind,
    recipient,
    asset,
    amount: String(amount),
    origin: context.origin,
  };
}
