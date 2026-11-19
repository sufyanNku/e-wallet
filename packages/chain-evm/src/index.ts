import { quoteBaseFees, observedBaseOperatorFee } from "./base-fees";
import {
  Contract,
  Interface,
  Transaction,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type JsonRpcProvider,
  type TransactionRequest,
} from "ethers";
import { z } from "zod";
import {
  WalletError,
  serviceStateSchema,
  assetKey,
  type AccountRef,
  type AssetBalance,
  type Collectible,
  type PreparedOperation,
  type TransactionIntent,
} from "@ewallet/domain";
import {
  deploymentSchema,
  type DeploymentManifest,
} from "@ewallet/domain/deployments";
import { networkById } from "@ewallet/config";
import { abis } from "@ewallet/config/abis";
import { WalletRpcProvider } from "./rpc";
export const evmPayloadSchema = z
  .object({
    family: z.literal("evm"),
    unsignedTransaction: z.string().regex(/^0x[0-9a-f]+$/i),
    bootEpoch: z.string().nullable(),
    accountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    observedBlock: z.string(),
    completeFee: z.boolean(),
    extraFeeMaximum: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
  })
  .strict();
export type EvmPayload = z.infer<typeof evmPayloadSchema>;
const tokenInterface = new Interface(abis.DemoERC20),
  nftInterface = new Interface(abis.DemoNFT721),
  multiInterface = new Interface(abis.DemoNFT1155);
export class EvmAdapter {
  readonly profile;
  readonly provider: JsonRpcProvider;
  constructor(
    readonly networkId: string,
    provider?: JsonRpcProvider,
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.profile = networkById(networkId);
    if (this.profile.family !== "evm")
      throw new WalletError("NETWORK", "This adapter requires an EVM profile.");
    this.provider = provider ?? new WalletRpcProvider(networkId);
  }
  async identity() {
    const chainId = BigInt(
      await this.provider.send("eth_chainId", []),
    ).toString();
    if (chainId !== this.profile.identity)
      throw new WalletError(
        "WRONG_NETWORK",
        "RPC chain identity does not match the selected network.",
      );
    return chainId;
  }
  async environment() {
    await this.identity();
    if (this.profile.environment !== "local") return { bootEpoch: null };
    const response = await this.fetcher(
      "/api/v1/environment/" + encodeURIComponent(this.networkId),
      { cache: "no-store", signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok)
      throw new WalletError(
        "ENVIRONMENT_UNAVAILABLE",
        "Local chain identity is unavailable.",
      );
    const body = (await response.json()) as { data: { bootEpoch: string } };
    if (typeof body.data?.bootEpoch !== "string")
      throw new WalletError(
        "ENVIRONMENT_UNAVAILABLE",
        "Invalid local chain epoch.",
      );
    return body.data;
  }
  async manifest(): Promise<DeploymentManifest | null> {
    const response = await this.fetcher(
      "/api/v1/deployments/" + encodeURIComponent(this.networkId),
      { cache: "no-store", signal: AbortSignal.timeout(10000) },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new WalletError("MANIFEST", "Deployment data is unavailable.");
    const body = (await response.json()) as { data: unknown };
    const m = deploymentSchema.parse(body.data);
    if (m.networkId !== this.networkId || m.chainId !== this.profile.identity)
      throw new WalletError("MANIFEST", "Deployment network mismatch.");
    if (
      this.profile.environment === "local" &&
      (await this.environment()).bootEpoch !== m.bootEpoch
    )
      throw new WalletError(
        "NEEDS_SEED",
        "Local chain restarted. Rebuild its demo dataset before using contracts.",
      );
    return m;
  }
  async verifyContract(manifest: DeploymentManifest, name: keyof typeof abis) {
    const entry = manifest.contracts[name];
    if (!entry)
      throw new WalletError(
        "CONTRACT_UNAVAILABLE",
        "This contract is not deployed on the selected network.",
      );
    const code = await this.provider.getCode(entry.address);
    if (code === "0x" || keccak256(code) !== entry.codeHash)
      throw new WalletError(
        "CONTRACT_CHANGED",
        "Contract code differs from the verified deployment. Reseed or verify the environment.",
      );
    return entry.address;
  }
  async tokenMetadata(reference: string, allowCanonicalAlias = false) {
    await this.identity();
    const address = getAddress(reference);
    if (
      !allowCanonicalAlias &&
      this.networkId === "eip155:5042002" &&
      address.toLowerCase() === "0x3600000000000000000000000000000000000000"
    )
      throw new WalletError(
        "CANONICAL_ASSET",
        "Arc USDC is already represented by the native balance; importing its ERC-20 view would count it twice.",
      );
    const code = await this.provider.getCode(address);
    if (code === "0x")
      throw new WalletError(
        "TOKEN_CONTRACT",
        "No contract exists at this address on the selected network.",
      );
    const token = new Contract(address, abis.DemoERC20, this.provider);
    const precision = BigInt(await token.decimals());
    if (precision > 36n)
      throw new WalletError(
        "DECIMALS",
        "This token has unsupported precision.",
      );
    let name = address,
      symbol = address.slice(0, 8);
    try {
      name = String(await token.name()).slice(0, 100);
      symbol = String(await token.symbol()).slice(0, 30);
    } catch {
      /* Address labels are safe when text metadata is absent. */
    }
    return {
      address,
      name,
      symbol,
      decimals: Number(precision),
      codeHash: keccak256(code),
    };
  }
  async balances(
    account: AccountRef,
    custom: Array<{
      reference: string;
      symbol: string;
      name: string;
      decimals: number;
      hidden?: boolean;
    }> = [],
  ): Promise<AssetBalance[]> {
    await this.identity();
    const block = await this.provider.getBlock("latest");
    if (!block)
      throw new WalletError(
        "RPC_UNAVAILABLE",
        "No current network observation.",
      );
    const observation = {
      source: "node" as const,
      networkId: this.networkId,
      observedHeight: String(block.number),
      observedAt: new Date().toISOString(),
      blockHash: block.hash ?? undefined,
    };
    const native = await this.provider.getBalance(
      account.address,
      block.number,
    );
    const symbol = this.profile.feeAsset.symbol;
    const result: AssetBalance[] = [
      {
        asset: {
          networkId: this.networkId,
          standard: "native",
          reference: "native",
        },
        raw: native.toString(),
        available: native.toString(),
        reserved: "0",
        decimals: 18,
        observation,
        symbol,
        name: this.profile.name,
        hidden: false,
        verified: true,
        microUsdRate:
          symbol === "USDC"
            ? "1000000"
            : symbol === "POL"
              ? "500000"
              : symbol === "tBNB"
                ? "300000000"
                : symbol === "HYPE"
                  ? "10000000"
                  : "2000000000",
        stale: false,
      },
    ];
    const m = await this.manifest();
    const registry = m?.assets.filter((a) => a.standard === "erc20") ?? [];
    const all = new Map(
      [...registry, ...custom].map((t) => [t.reference.toLowerCase(), t]),
    );
    for (const asset of all.values()) {
      if (
        this.networkId === "eip155:5042002" &&
        asset.reference.toLowerCase() ===
          "0x3600000000000000000000000000000000000000"
      )
        continue;
      const contract = new Contract(
        asset.reference,
        abis.DemoERC20,
        this.provider,
      );
      const [raw, precision] = await Promise.all([
        contract.balanceOf(account.address, { blockTag: block.number }),
        contract.decimals({ blockTag: block.number }),
      ]);
      if (BigInt(precision) > 36n || Number(precision) !== asset.decimals)
        throw new WalletError(
          "DECIMALS_CHANGED",
          "Token precision changed. Review the token again.",
        );
      result.push({
        asset: {
          networkId: this.networkId,
          standard: "erc20",
          reference: getAddress(asset.reference).toLowerCase(),
        },
        raw: String(raw),
        available: String(raw),
        reserved: "0",
        decimals: asset.decimals,
        observation,
        symbol: asset.symbol,
        name: asset.name,
        hidden: asset.hidden ?? false,
        verified: registry.some(
          (t) => t.reference.toLowerCase() === asset.reference.toLowerCase(),
        ),
        microUsdRate: ["dUSDC", "dDAI", "bdUSDC"].includes(asset.symbol)
          ? "1000000"
          : asset.symbol === "EWLT"
            ? "100000"
            : null,
        stale: false,
      });
    }
    return result;
  }
  async collectibles(account: AccountRef): Promise<Collectible[]> {
    const manifest = await this.manifest();
    if (!manifest) return [];
    const block = await this.provider.getBlock("latest");
    if (!block) return [];
    const collectibles: Collectible[] = [];
    for (const asset of manifest.assets.filter((a) => a.standard !== "erc20")) {
      const contract = new Contract(
        asset.reference,
        asset.standard === "erc721" ? abis.DemoNFT721 : abis.DemoNFT1155,
        this.provider,
      );
      for (const id of asset.tokenIds ?? []) {
        let quantity: bigint;
        try {
          quantity =
            asset.standard === "erc721"
              ? getAddress(await contract.ownerOf(id)) ===
                getAddress(account.address)
                ? 1n
                : 0n
              : BigInt(await contract.balanceOf(account.address, id));
        } catch {
          continue;
        }
        if (quantity === 0n) continue;
        collectibles.push({
          id: `${this.networkId}:${asset.reference}:${id}`,
          asset: {
            networkId: this.networkId,
            standard: asset.standard,
            reference: asset.reference.toLowerCase(),
            tokenId: id,
          },
          name:
            asset.standard === "erc721"
              ? `Campus Pass #${id}`
              : `Study Club #${id}`,
          quantity: quantity.toString(),
          metadataStatus: "missing",
          image: null,
          owner: account.address,
          observation: {
            source: "node",
            networkId: this.networkId,
            observedHeight: String(block.number),
            observedAt: new Date().toISOString(),
            blockHash: block.hash ?? undefined,
          },
        });
      }
    }
    return collectibles;
  }
  async discoverAccounts(accounts: AccountRef[]) {
    await this.identity();
    const manifest = await this.manifest(),
      height = await this.provider.getBlockNumber(),
      nftOwners = new Set<string>();
    if (manifest)
      for (const asset of manifest.assets.filter(
        (a) => a.standard === "erc721",
      )) {
        const c = new Contract(asset.reference, abis.DemoNFT721, this.provider);
        for (const id of asset.tokenIds ?? [])
          nftOwners.add(getAddress(await c.ownerOf(id)));
      }
    const results: Array<{ account: AccountRef; used: boolean }> = [],
      queue = [...accounts];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (queue.length) {
          const account = queue.shift()!;
          let used =
            nftOwners.has(getAddress(account.address)) ||
            (await this.provider.getTransactionCount(account.address)) > 0 ||
            (await this.provider.getBalance(account.address)) > 0n;
          if (!used && manifest)
            for (const asset of manifest.assets) {
              if (
                asset.standard === "erc20" &&
                BigInt(
                  await new Contract(
                    asset.reference,
                    abis.DemoERC20,
                    this.provider,
                  ).balanceOf(account.address),
                ) > 0n
              ) {
                used = true;
                break;
              }
              if (asset.standard === "erc1155") {
                const c = new Contract(
                  asset.reference,
                  abis.DemoNFT1155,
                  this.provider,
                );
                for (const id of asset.tokenIds ?? [])
                  if (BigInt(await c.balanceOf(account.address, id)) > 0n) {
                    used = true;
                    break;
                  }
              }
              if (used) break;
            }
          results.push({ account, used });
        }
      }),
    );
    await this.identity();
    return {
      results: results.sort((a, b) => a.account.index - b.account.index),
      height: String(height),
      coverage:
        "Native balance/nonces and the registered ERC-20/ERC-721/ERC-1155 registry. Unknown historical assets need indexed backfill.",
    };
  }
  async services(account: AccountRef) {
    const manifest = await this.manifest();
    if (!manifest || this.networkId !== "eip155:31337")
      throw new WalletError(
        "SERVICE_UNAVAILABLE",
        "Select the seeded local EVM A network for these services.",
      );
    const names = {
      faucet: "DemoFaucet",
      vault: "SavingsVault",
      pool: "DemoSwapPool",
      shared: "SharedWallet",
      bridge: "DemoBridgeLock",
    } as const;
    const contracts = {} as Record<keyof typeof names, string>;
    for (const key of Object.keys(names) as Array<keyof typeof names>)
      contracts[key] = await this.verifyContract(manifest, names[key]);
    const block = await this.provider.getBlock("latest");
    if (!block)
      throw new WalletError(
        "RPC_UNAVAILABLE",
        "Current chain block unavailable.",
      );
    const overrides = { blockTag: block.number };
    const tokenRef = manifest.contracts.dUSDC.address,
      outputRef = manifest.contracts.dDAI.address;
    const metadata = await this.tokenMetadata(tokenRef),
      out = await this.tokenMetadata(outputRef);
    const token = {
        reference: metadata.address,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
      },
      outputToken = {
        reference: out.address,
        symbol: out.symbol,
        decimals: out.decimals,
      };
    const erc = new Contract(tokenRef, abis.DemoERC20, this.provider),
      faucet = new Contract(contracts.faucet, abis.DemoFaucet, this.provider),
      vault = new Contract(contracts.vault, abis.SavingsVault, this.provider),
      shared = new Contract(contracts.shared, abis.SharedWallet, this.provider);
    const positions = [],
      proposals = [],
      owners: string[] = [];
    const positionCount = BigInt(await vault.positionCount(overrides)),
      proposalCount = BigInt(await shared.proposalCount(overrides));
    if (positionCount > 500n || proposalCount > 500n)
      throw new WalletError(
        "SERVICE_RANGE",
        "This service exceeds the bounded local view. Use the indexed history.",
      );
    for (let i = 0; i < 3; i++)
      owners.push(getAddress(await shared.owners(i, overrides)));
    for (let i = 0n; i < positionCount; i++) {
      const p = await vault.positions(i, overrides);
      if (getAddress(p.owner) !== getAddress(account.address)) continue;
      const m = await this.tokenMetadata(p.token);
      positions.push({
        id: String(i),
        token: { reference: m.address, symbol: m.symbol, decimals: m.decimals },
        amount: String(p.amount),
        unlockAt: String(p.unlockAt),
        withdrawn: p.withdrawn,
      });
    }
    for (let i = 0n; i < proposalCount; i++) {
      const p = await shared.proposal(i, overrides),
        approvals: string[] = [];
      for (const owner of owners)
        if (await shared.approved(i, owner, overrides)) approvals.push(owner);
      let recipient = getAddress(p.destination),
        amount = String(p.value),
        standard: "native" | "erc20" = "native",
        proposalToken = null,
        supported = false;
      if (p.data === "0x" && BigInt(p.value) > 0n)
        supported =
          (await this.provider.getCode(p.destination, block.number)) === "0x";
      else if (
        BigInt(p.value) === 0n &&
        manifest.assets.some(
          (a) =>
            a.standard === "erc20" &&
            a.reference.toLowerCase() === String(p.destination).toLowerCase(),
        )
      ) {
        try {
          const decoded = tokenInterface.parseTransaction({ data: p.data });
          if (decoded?.name === "transfer") {
            const m = await this.tokenMetadata(p.destination);
            recipient = getAddress(decoded.args[0]);
            amount = String(decoded.args[1]);
            standard = "erc20";
            proposalToken = {
              reference: m.address,
              symbol: m.symbol,
              decimals: m.decimals,
            };
            supported = true;
          }
        } catch {
          /* Unsupported calldata remains visible without actions. */
        }
      }
      proposals.push({
        id: String(i),
        recipient,
        amount,
        standard,
        token: proposalToken,
        approvals,
        executed: p.executed,
        supported,
      });
    }
    return serviceStateSchema.parse({
      networkId: this.networkId,
      accountAddress: account.address,
      observedBlock: String(block.number),
      chainTimestamp: String(block.timestamp),
      observedAt: new Date().toISOString(),
      contracts,
      token,
      outputToken,
      faucet: {
        amount: String(await faucet.claimAmount(tokenRef, overrides)),
        nextClaimAt: String(
          await faucet.nextClaimAt(account.address, tokenRef, overrides),
        ),
        claims: String(
          await faucet.claims(account.address, tokenRef, overrides),
        ),
        maximumClaims: String(await faucet.MAX_CLAIMS(overrides)),
      },
      allowances: {
        vault: String(
          await erc.allowance(account.address, contracts.vault, overrides),
        ),
        pool: String(
          await erc.allowance(account.address, contracts.pool, overrides),
        ),
        bridge: String(
          await erc.allowance(account.address, contracts.bridge, overrides),
        ),
      },
      positions,
      shared: {
        owners,
        nativeBalance: String(
          await this.provider.getBalance(contracts.shared, block.number),
        ),
        tokenBalance: String(await erc.balanceOf(contracts.shared, overrides)),
        proposals,
      },
    });
  }
  async quote(account: AccountRef, amount: string, slippageBps: string) {
    if (
      !/^[1-9][0-9]*$/.test(amount) ||
      !/^[0-9]+$/.test(slippageBps) ||
      BigInt(slippageBps) < 1n ||
      BigInt(slippageBps) > 500n
    )
      throw new WalletError(
        "QUOTE_POLICY",
        "Use a positive amount and slippage between 0.01% and 5%.",
      );
    const state = await this.services(account),
      pool = new Contract(
        state.contracts.pool,
        abis.DemoSwapPool,
        this.provider,
      ),
      tag = { blockTag: Number(state.observedBlock) },
      input = BigInt(amount);
    const output = BigInt(
        await pool.quoteExactInput(state.token.reference, input, tag),
      ),
      reserveIn = BigInt(await pool.reserve0(tag)),
      reserveOut = BigInt(await pool.reserve1(tag));
    const ideal = (input * 997n * reserveOut) / (reserveIn * 1000n),
      impact = ideal > 0n ? ((ideal - output) * 10000n) / ideal : 0n;
    return {
      quoteId: crypto.randomUUID(),
      amountIn: amount,
      output: String(output),
      minimum: String((output * (10000n - BigInt(slippageBps))) / 10000n),
      expiresAt: Date.now() + 30000,
      deadline: String(BigInt(state.chainTimestamp) + 300n),
      slippageBps,
      priceImpactBps: String(impact),
      allowance: state.allowances.pool,
    };
  }
  async prepare(
    intent: TransactionIntent,
    account: AccountRef,
    nonce: number,
    bootEpoch: string | null,
  ): Promise<PreparedOperation> {
    await this.identity();
    if (
      account.family !== "evm" ||
      intent.networkId !== this.networkId ||
      intent.accountId !== account.id ||
      intent.asset.networkId !== this.networkId
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Account, asset and network must match.",
      );
    const amount = BigInt(intent.amount);
    if (amount === 0n && !["revoke", "approve"].includes(intent.kind))
      throw new WalletError("AMOUNT", "Amount must be greater than zero.");
    let to = getAddress(intent.recipient),
      value = 0n,
      data = "0x";
    const warnings: string[] = [];
    const metadata =
      intent.asset.standard === "erc20"
        ? await this.tokenMetadata(intent.asset.reference, true)
        : null;
    let previewRecipient = intent.recipient,
      decodedOperation = "Native transfer";
    const displaySymbol =
        metadata?.symbol ??
        (intent.asset.standard === "native"
          ? this.profile.feeAsset.symbol
          : "Collectible"),
      displayDecimals =
        metadata?.decimals ?? (intent.asset.standard === "native" ? 18 : 0);
    if (to === "0x0000000000000000000000000000000000000000")
      throw new WalletError("RECIPIENT", "The zero address is unsupported.");
    if (to === getAddress(account.address))
      warnings.push("This recipient is your own account.");
    if (intent.kind === "send") {
      if (intent.asset.standard === "native") {
        value = amount;
        if ((await this.provider.getCode(to)) !== "0x") {
          const m = await this.manifest();
          const known = m ? await this.verifyContract(m, "SharedWallet") : null;
          if (!known || getAddress(known) !== to)
            throw new WalletError(
              "UNSUPPORTED_RECIPIENT",
              "Native transfer to an unknown contract is not supported by this decoded build.",
            );
          decodedOperation = "Fund the verified two-of-three shared wallet";
        }
      } else if (intent.asset.standard === "erc20") {
        const token = metadata!;
        const c = new Contract(token.address, abis.DemoERC20, this.provider);
        if (BigInt(await c.balanceOf(account.address)) < amount)
          throw new WalletError(
            "INSUFFICIENT_FUNDS",
            "Token balance is insufficient.",
          );
        data = tokenInterface.encodeFunctionData("transfer", [to, amount]);
        decodedOperation = `ERC-20 transfer(${to}, ${amount} base units)`;
        to = token.address;
      } else
        throw new WalletError(
          "UNSUPPORTED_ASSET",
          "Use a collectible transfer for this asset.",
        );
    } else if (intent.kind === "nft-transfer") {
      if (intent.asset.standard === "erc721") {
        if (amount !== 1n)
          throw new WalletError(
            "NFT_QUANTITY",
            "ERC-721 transfer quantity must be one.",
          );
        const c = new Contract(
          intent.asset.reference,
          abis.DemoNFT721,
          this.provider,
        );
        if (!(await c.supportsInterface("0x80ac58cd")))
          throw new WalletError(
            "UNSUPPORTED_NFT",
            "Contract does not support ERC-721.",
          );
        if (
          getAddress(await c.ownerOf(intent.asset.tokenId)) !==
          getAddress(account.address)
        )
          throw new WalletError(
            "OWNERSHIP",
            "You no longer own this collectible.",
          );
        data = nftInterface.encodeFunctionData(
          "safeTransferFrom(address,address,uint256)",
          [account.address, to, intent.asset.tokenId],
        );
        decodedOperation = `ERC-721 safeTransferFrom(${account.address}, ${to}, token ${intent.asset.tokenId})`;
      } else if (intent.asset.standard === "erc1155") {
        const c = new Contract(
          intent.asset.reference,
          abis.DemoNFT1155,
          this.provider,
        );
        if (!(await c.supportsInterface("0xd9b67a26")))
          throw new WalletError(
            "UNSUPPORTED_NFT",
            "Contract does not support ERC-1155.",
          );
        if (
          BigInt(await c.balanceOf(account.address, intent.asset.tokenId)) <
          amount
        )
          throw new WalletError(
            "OWNERSHIP",
            "Collectible quantity exceeds ownership.",
          );
        data = multiInterface.encodeFunctionData("safeTransferFrom", [
          account.address,
          to,
          intent.asset.tokenId,
          amount,
          "0x",
        ]);
        decodedOperation = `ERC-1155 safeTransferFrom(${account.address}, ${to}, token ${intent.asset.tokenId}, quantity ${amount})`;
      } else
        throw new WalletError(
          "UNSUPPORTED_ASSET",
          "Unsupported collectible standard.",
        );
      to = getAddress(intent.asset.reference);
    } else if (intent.kind === "approve" || intent.kind === "revoke") {
      if (intent.asset.standard !== "erc20")
        throw new WalletError(
          "UNSUPPORTED_ASSET",
          "Only decoded ERC-20 allowance changes are supported here.",
        );
      const existing = BigInt(
        await new Contract(
          intent.asset.reference,
          abis.DemoERC20,
          this.provider,
        ).allowance(account.address, to),
      );
      if (
        intent.kind === "approve" &&
        amount > 0n &&
        existing > 0n &&
        existing !== amount
      )
        throw new WalletError(
          "ALLOWANCE_RESET_REQUIRED",
          "Revoke the existing allowance to zero before reviewing a new exact allowance.",
        );
      data = tokenInterface.encodeFunctionData("approve", [
        to,
        intent.kind === "revoke" ? 0n : amount,
      ]);
      decodedOperation = `ERC-20 approve(spender ${to}, exact amount ${intent.kind === "revoke" ? 0n : amount})`;
      to = getAddress(intent.asset.reference);
      warnings.push(
        "Connection grants and token allowances are separate permissions.",
      );
    } else {
      const manifest = await this.manifest();
      if (!manifest)
        throw new WalletError(
          "CONTRACT_UNAVAILABLE",
          "No verified contract deployment exists.",
        );
      if (
        !["execute", "multisig-approve", "multisig-revoke", "propose"].includes(
          intent.kind,
        ) &&
        intent.asset.standard !== "erc20"
      )
        throw new WalletError(
          "SERVICE_ASSET",
          "This service requires its registered ERC-20 asset.",
        );
      if (
        intent.kind === "propose" &&
        !["native", "erc20"].includes(intent.asset.standard)
      )
        throw new WalletError(
          "SERVICE_ASSET",
          "Only native and ERC-20 proposals are supported.",
        );
      if (intent.kind === "propose") {
        if (
          intent.asset.standard === "native" &&
          (await this.provider.getCode(to)) !== "0x"
        )
          throw new WalletError(
            "UNSUPPORTED_PROPOSAL",
            "Native proposals must target an ordinary account.",
          );
        if (
          intent.asset.standard === "erc20" &&
          !manifest.assets.some(
            (a) =>
              a.standard === "erc20" &&
              a.reference.toLowerCase() ===
                intent.asset.reference.toLowerCase(),
          )
        )
          throw new WalletError(
            "UNSUPPORTED_PROPOSAL",
            "Select a registered ERC-20 for a shared-wallet proposal.",
          );
      }
      const p = intent.parameters ?? {};
      const service: {
        name: keyof typeof abis;
        method: string;
        args: unknown[];
      } =
        intent.kind === "faucet"
          ? {
              name: "DemoFaucet",
              method: "claim",
              args: [intent.asset.reference],
            }
          : intent.kind === "deposit"
            ? {
                name: "SavingsVault",
                method: "deposit",
                args: [
                  intent.asset.reference,
                  amount,
                  BigInt(p.duration ?? "0"),
                ],
              }
            : intent.kind === "withdraw"
              ? {
                  name: "SavingsVault",
                  method: "withdraw",
                  args: [BigInt(p.positionId ?? "-1")],
                }
              : intent.kind === "swap"
                ? {
                    name: "DemoSwapPool",
                    method: "swapExactInput",
                    args: [
                      intent.asset.reference,
                      amount,
                      BigInt(p.minimum ?? "0"),
                      BigInt(p.deadline ?? "0"),
                      account.address,
                    ],
                  }
                : intent.kind === "bridge"
                  ? {
                      name: "DemoBridgeLock",
                      method: "lock",
                      args: [
                        amount,
                        getAddress(p.recipient ?? account.address),
                        31338,
                      ],
                    }
                  : intent.kind === "propose"
                    ? {
                        name: "SharedWallet",
                        method: "propose",
                        args: [
                          intent.asset.standard === "native"
                            ? to
                            : intent.asset.reference,
                          intent.asset.standard === "native" ? amount : 0n,
                          intent.asset.standard === "native"
                            ? "0x"
                            : tokenInterface.encodeFunctionData("transfer", [
                                to,
                                amount,
                              ]),
                        ],
                      }
                    : intent.kind === "multisig-approve"
                      ? {
                          name: "SharedWallet",
                          method: "approve",
                          args: [BigInt(p.proposalId ?? "-1")],
                        }
                      : intent.kind === "multisig-revoke"
                        ? {
                            name: "SharedWallet",
                            method: "revoke",
                            args: [BigInt(p.proposalId ?? "-1")],
                          }
                        : intent.kind === "execute"
                          ? {
                              name: "SharedWallet",
                              method: "execute",
                              args: [BigInt(p.proposalId ?? "-1")],
                            }
                          : (() => {
                              throw new WalletError(
                                "UNSUPPORTED_OPERATION",
                                "Unknown contract operation.",
                              );
                            })();
      const chainBlock = await this.provider.getBlock("latest");
      if (
        intent.kind === "swap" &&
        (Number(p.quoteExpiry ?? 0) < Date.now() ||
          BigInt(p.deadline ?? "0") < BigInt(chainBlock?.timestamp ?? 0) ||
          Number(p.quoteExpiry ?? 0) > Date.now() + 30000)
      )
        throw new WalletError(
          "STALE_QUOTE",
          "Refresh the quote and review again.",
        );
      const actual = await this.verifyContract(manifest, service.name);
      const contract = new Contract(actual, abis[service.name], this.provider);
      if (
        intent.kind === "bridge" &&
        getAddress(intent.asset.reference) !==
          getAddress(await contract.token())
      )
        throw new WalletError(
          "SERVICE_ASSET",
          "Bridge token differs from the reviewed asset.",
        );
      if (intent.kind === "faucet") {
        const configured = BigInt(
          await contract.claimAmount(intent.asset.reference),
        );
        if (configured === 0n || configured !== amount)
          throw new WalletError(
            "FAUCET_AMOUNT_CHANGED",
            "The faucet claim amount differs from this review. Refresh the service state.",
          );
        previewRecipient = account.address;
      }
      if (intent.kind === "withdraw") {
        const position = await contract.positions(p.positionId);
        if (
          getAddress(position.owner) !== getAddress(account.address) ||
          getAddress(position.token) !== getAddress(intent.asset.reference) ||
          BigInt(position.amount) !== amount
        )
          throw new WalletError(
            "POSITION_CHANGED",
            "The selected vault position differs from this review.",
          );
        previewRecipient = account.address;
      }
      if (
        ["execute", "multisig-approve", "multisig-revoke"].includes(intent.kind)
      ) {
        const proposal = await contract.proposal(p.proposalId);
        let targetRecipient: string, targetAmount: bigint;
        if (proposal.data === "0x" && BigInt(proposal.value) > 0n) {
          if (
            intent.asset.standard !== "native" ||
            (await this.provider.getCode(proposal.destination)) !== "0x"
          )
            throw new WalletError(
              "UNSUPPORTED_PROPOSAL",
              "Only decoded native transfers to ordinary accounts are supported.",
            );
          targetRecipient = getAddress(proposal.destination);
          targetAmount = BigInt(proposal.value);
        } else {
          if (
            BigInt(proposal.value) !== 0n ||
            !manifest.assets.some(
              (a) =>
                a.standard === "erc20" &&
                a.reference.toLowerCase() ===
                  String(proposal.destination).toLowerCase(),
            )
          )
            throw new WalletError(
              "UNSUPPORTED_PROPOSAL",
              "Unknown shared-wallet call target.",
            );
          const decoded = tokenInterface.parseTransaction({
            data: proposal.data,
          });
          if (
            !decoded ||
            decoded.name !== "transfer" ||
            getAddress(proposal.destination) !==
              getAddress(intent.asset.reference)
          )
            throw new WalletError(
              "UNSUPPORTED_PROPOSAL",
              "Only decoded ERC-20 transfers are supported.",
            );
          targetRecipient = getAddress(decoded.args[0]);
          targetAmount = BigInt(decoded.args[1]);
        }
        if (amount !== targetAmount)
          throw new WalletError(
            "PROPOSAL_CHANGED",
            "Shared-wallet proposal amount differs from this review.",
          );
        previewRecipient = targetRecipient;
        decodedOperation = `${service.method} proposal ${p.proposalId}: transfer ${targetAmount} base units to ${targetRecipient}; current approvals ${proposal.confirmations}/2`;
      }
      if (
        intent.kind !== "propose" &&
        getAddress(intent.recipient) !== getAddress(actual)
      )
        throw new WalletError(
          "CONTRACT_CHANGED",
          "The reviewed contract does not match the deployment.",
        );
      to = actual;
      data = new Interface(abis[service.name]).encodeFunctionData(
        service.method,
        service.args,
      );
      if (
        !["execute", "multisig-approve", "multisig-revoke"].includes(
          intent.kind,
        )
      )
        decodedOperation = `${service.name}.${service.method}(${service.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ")})`;
    }
    const request: TransactionRequest = {
      from: account.address,
      to,
      value,
      data,
      nonce,
      chainId: BigInt(this.profile.identity),
    };
    let gas: bigint;
    try {
      await this.provider.call(request);
      gas = await this.provider.estimateGas(request);
    } catch {
      throw new WalletError(
        "SIMULATION_FAILED",
        "The operation would fail on current chain state. Check balances, permissions and contract eligibility.",
      );
    }
    const gasLimit = (gas * 120n + 99n) / 100n,
      fees = await this.provider.getFeeData();
    if (gasLimit > 10000000n)
      throw new WalletError(
        "GAS_LIMIT",
        "This operation exceeds the supported gas bound.",
      );
    let maximum: bigint;
    if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
      request.type = 2;
      request.maxFeePerGas = fees.maxFeePerGas;
      request.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      maximum = gasLimit * fees.maxFeePerGas;
    } else if (fees.gasPrice !== null) {
      request.type = 0;
      request.gasPrice = fees.gasPrice;
      maximum = gasLimit * fees.gasPrice;
    } else
      throw new WalletError(
        "FEES_UNAVAILABLE",
        "A complete fee quote is unavailable.",
      );
    request.gasLimit = gasLimit;
    const unsignedTransaction = Transaction.from({
        to,
        value,
        data,
        nonce,
        chainId: BigInt(this.profile.identity),
        gasLimit,
        type: request.type === 2 ? 2 : 0,
        ...(request.type === 2
          ? {
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            }
          : { gasPrice: fees.gasPrice }),
      }).unsignedSerialized,
      block = await this.provider.getBlockNumber(),
      now = Date.now(),
      expiresAt =
        intent.kind === "swap"
          ? Math.min(now + 60000, Number(intent.parameters?.quoteExpiry ?? 0))
          : now + 60000;
    let extraFeeMaximum = 0n,
      extraFeeEstimate = 0n;
    if (this.networkId === "eip155:84532") {
      const quote = await quoteBaseFees(
        this.provider,
        unsignedTransaction,
        gasLimit,
      );
      extraFeeMaximum = quote.maximumExtra;
      extraFeeEstimate = quote.l1Fee + quote.operatorFee;
      maximum += extraFeeMaximum;
      warnings.push(
        `Base fee includes L1 data and operator charges; ${extraFeeMaximum} wei is reserved for these charges. The oracle estimate is rechecked before signing.`,
      );
    }
    if (
      (await this.provider.getBalance(account.address, "pending")) <
      value + maximum
    )
      throw new WalletError(
        "INSUFFICIENT_FEE",
        "Keep enough native currency for the complete maximum fee and transfer.",
      );
    const payload: EvmPayload = {
      family: "evm",
      unsignedTransaction,
      bootEpoch,
      accountAddress: account.address,
      observedBlock: String(block),
      completeFee: true,
      extraFeeMaximum: String(extraFeeMaximum),
    };
    const encodedPayload = JSON.stringify(payload),
      digest = keccak256(
        toUtf8Bytes(JSON.stringify({ intent, payload, expiresAt })),
      );
    return {
      id: crypto.randomUUID(),
      intent: structuredClone(intent),
      encodedPayload,
      preview: {
        sender: account.address,
        title: intent.kind,
        recipient: previewRecipient,
        amount: intent.amount,
        warnings,
        assetSymbol: displaySymbol,
        decimals: displayDecimals,
        decodedOperation,
        contractAddress: data !== "0x" ? to : undefined,
        nonce: String(nonce),
      },
      fee: {
        estimated: (
          gas * (fees.gasPrice ?? fees.maxFeePerGas!) +
          extraFeeEstimate
        ).toString(),
        maximum: maximum.toString(),
        symbol: this.profile.feeAsset.symbol,
        decimals: 18,
      },
      createdAt: now,
      expiresAt,
      fingerprint: `${this.networkId}:${account.address}:${nonce}:${bootEpoch ?? "public"}`,
      digest: digest.slice(2),
      source: "node",
    };
  }
  async allowances(account: AccountRef) {
    const manifest = await this.manifest();
    if (!manifest) return [];
    const end = await this.provider.getBlockNumber(),
      start = Math.max(Number(manifest.deploymentBlock), end - 2000),
      result: Array<{
        id: string;
        asset: { networkId: string; standard: "erc20"; reference: string };
        spender: string;
        raw: string;
        symbol: string;
        decimals: number;
      }> = [];
    for (const asset of manifest.assets.filter((a) => a.standard === "erc20")) {
      const c = new Contract(asset.reference, abis.DemoERC20, this.provider),
        spenders = new Set<string>();
      for (let from = start; from <= end; from += this.profile.logRangeLimit) {
        for (const log of await c.queryFilter(
          c.filters.Approval(account.address, null),
          from,
          Math.min(end, from + this.profile.logRangeLimit - 1),
        )) {
          const event = c.interface.parseLog(log);
          if (event) spenders.add(getAddress(event.args[1]));
        }
      }
      for (const spender of spenders) {
        const raw = BigInt(await c.allowance(account.address, spender));
        if (raw > 0n)
          result.push({
            id: `${this.networkId}:${asset.reference}:${spender}`,
            asset: {
              networkId: this.networkId,
              standard: "erc20",
              reference: asset.reference.toLowerCase(),
            },
            spender,
            raw: raw.toString(),
            symbol: asset.symbol,
            decimals: asset.decimals,
          });
      }
    }
    return result;
  }
  async revalidate(op: PreparedOperation, account: AccountRef) {
    const payload = evmPayloadSchema.parse(JSON.parse(op.encodedPayload));
    const env = await this.environment();
    if (env.bootEpoch !== payload.bootEpoch)
      throw new WalletError(
        "CHAIN_RESTARTED",
        "The local chain restarted. Cancel this operation and rebuild the demo environment.",
      );
    const tx = Transaction.from(payload.unsignedTransaction);
    if (
      tx.chainId !== BigInt(this.profile.identity) ||
      getAddress(payload.accountAddress) !== getAddress(account.address)
    )
      throw new WalletError(
        "WRONG_NETWORK",
        "Reviewed payload identity mismatch.",
      );
    const nonce = await this.provider.getTransactionCount(
      account.address,
      "pending",
    );
    if (nonce !== tx.nonce)
      throw new WalletError(
        "NONCE_CHANGED",
        "Account nonce changed. Prepare and review a fresh operation.",
      );
    if (this.networkId === "eip155:84532") {
      if (!payload.extraFeeMaximum || !payload.completeFee)
        throw new WalletError(
          "FEES_UNAVAILABLE",
          "The reviewed Base fee is incomplete.",
        );
      const quote = await quoteBaseFees(
        this.provider,
        payload.unsignedTransaction,
        tx.gasLimit,
      );
      const extra = quote.l1Fee + quote.operatorFee;
      if (extra > BigInt(payload.extraFeeMaximum))
        throw new WalletError(
          "FEES_CHANGED",
          "Base L1/operator fees exceed the reviewed reserve. Request a fresh review.",
        );
    }
    const value = tx.value,
      fee =
        tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) +
        BigInt(payload.extraFeeMaximum ?? "0");
    if (
      (await this.provider.getBalance(account.address, "pending")) <
      value + fee
    )
      throw new WalletError(
        "INSUFFICIENT_FUNDS",
        "Native balance changed after review.",
      );
    await this.provider.call({
      from: account.address,
      to: tx.to,
      value,
      data: tx.data,
      gasLimit: tx.gasLimit,
      ...(tx.type === 2
        ? {
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          }
        : { gasPrice: tx.gasPrice }),
      blockTag: "pending",
    });
    return payload;
  }
  async status(hash: string) {
    await this.identity();
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt)
      return {
        state: "submitted" as const,
        height: null,
        fee: null,
        blockHash: null,
      };
    let observedFee: string | null = receipt.fee.toString();
    if (this.networkId === "eip155:84532") {
      try {
        const rawReceipt = z
            .object({ l1Fee: z.string().regex(/^0x[0-9a-f]+$/i) })
            .parse(
              await this.provider.send("eth_getTransactionReceipt", [hash]),
            ),
          operator = await observedBaseOperatorFee(
            this.provider,
            receipt.gasUsed,
            "0x" + receipt.blockNumber.toString(16),
          );
        observedFee = String(receipt.fee + BigInt(rawReceipt.l1Fee) + operator);
      } catch {
        observedFee = null;
      }
    }
    const block = await this.provider.getBlock(receipt.blockNumber);
    if (block?.hash !== receipt.blockHash)
      return {
        state: "orphaned" as const,
        height: String(receipt.blockNumber),
        fee: observedFee,
        blockHash: receipt.blockHash,
      };
    const confirmations = await receipt.confirmations();
    return {
      state:
        receipt.status === 0
          ? ("reverted" as const)
          : confirmations >= this.profile.finality.confirmations
            ? ("confirmed" as const)
            : ("included" as const),
      height: String(receipt.blockNumber),
      fee: observedFee,
      blockHash: receipt.blockHash,
    };
  }
}
export { assetKey };
