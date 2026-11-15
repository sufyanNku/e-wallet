import { networkProfileSchema, type NetworkProfile } from "@ewallet/domain";
const evm: Array<[number, string, string, string, string | null, number]> = [
  [31337, "Local Ethereum", "ETH", "http://127.0.0.1:8545", null, 1],
  [31338, "Local bridge destination", "ETH", "http://127.0.0.1:8546", null, 1],
  [
    11155111,
    "Ethereum Sepolia",
    "ETH",
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.etherscan.io",
    2,
  ],
  [
    84532,
    "Base Sepolia",
    "ETH",
    "https://sepolia.base.org",
    "https://sepolia.basescan.org",
    2,
  ],
  [
    80002,
    "Polygon Amoy",
    "POL",
    "https://polygon-amoy.drpc.org",
    "https://amoy.polygonscan.com",
    3,
  ],
  [
    97,
    "BNB Testnet",
    "tBNB",
    "https://bsc-testnet.bnbchain.org",
    "https://testnet.bscscan.com",
    3,
  ],
  [
    998,
    "HyperEVM Testnet",
    "HYPE",
    "https://rpc.hyperliquid-testnet.xyz/evm",
    null,
    2,
  ],
  [
    46630,
    "Robinhood Testnet",
    "ETH",
    "https://rpc.testnet.chain.robinhood.com",
    "https://explorer.testnet.chain.robinhood.com",
    2,
  ],
  [
    5042002,
    "Arc Testnet",
    "USDC",
    "https://rpc.testnet.arc.io",
    "https://explorer.testnet.arc.io",
    2,
  ],
];
export const networks: NetworkProfile[] = [
  ...evm.map(([chain, name, symbol, rpc, explorer, confirmations]) =>
    networkProfileSchema.parse({
      id: `eip155:${chain}`,
      name,
      family: "evm",
      environment:
        chain < 40000 && (chain === 31337 || chain === 31338)
          ? "local"
          : "testnet",
      identity: String(chain),
      logRangeLimit: chain === 998 ? 50 : 1000,
      rpcs: [rpc],
      feeAsset: { symbol, decimals: 18 },
      explorer,
      capabilities: ["native", "erc20", "erc721", "erc1155"],
      finality: {
        confirmations,
        label:
          "Application inclusion threshold; protocol finality tracked separately",
      },
    }),
  ),
  ...(["local", "devnet"] as const).map((cluster) =>
    networkProfileSchema.parse({
      id: `solana:${cluster}`,
      name: cluster === "local" ? "Solana Local" : "Solana Devnet",
      family: "solana",
      environment: cluster === "local" ? "local" : "testnet",
      identity:
        cluster === "local"
          ? "record-at-boot"
          : "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      rpcs: [
        cluster === "local"
          ? "http://127.0.0.1:8899"
          : "https://api.devnet.solana.com",
      ],
      feeAsset: { symbol: "SOL", decimals: 9 },
      explorer: cluster === "devnet" ? "https://explorer.solana.com" : null,
      capabilities: ["native", "spl", "solana-nft"],
      finality: {
        confirmations: 1,
        label: "Confirmed; finalized reported independently",
      },
    }),
  ),
  networkProfileSchema.parse({
    id: "bitcoin:regtest",
    name: "Bitcoin Regtest",
    family: "bitcoin",
    environment: "local",
    identity: "regtest",
    rpcs: ["http://127.0.0.1:8787/api/v1/rpc/bitcoin%3Aregtest"],
    feeAsset: { symbol: "BTC", decimals: 8 },
    explorer: null,
    capabilities: ["p2wpkh", "p2tr"],
    finality: {
      confirmations: 6,
      label: "1 confirmation included; 6 local completion threshold",
    },
  }),
];
export function networkById(id: string) {
  const n = networks.find((n) => n.id === id);
  if (!n) throw new Error("Unsupported network");
  return n;
}
