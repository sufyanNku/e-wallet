// Presentation names only. Network IDs, contract metadata and signing payloads
// retain their original values throughout the wallet.
export function displayAssetName(name: string): string {
  return name
    .replace(/\bDemo\s+/g, "")
    .replace(/^Campus Pass/, "Access Pass")
    .replace(/^Study Club/, "Membership")
    .trim();
}

export function displayNetworkName(network: {
  id: string;
  name: string;
}): string {
  const name = network.name.replace(/\s+Testnet\b/g, "").trim();
  return name === network.name
    ? name
    : `${name} · ${network.id.split(":").at(-1)}`;
}

export function displayAccountName(name: string): string {
  const legacyNames: Record<string, string> = {
    "Demo administrator": "Administrator",
    "Demo auditor": "Auditor",
  };
  return legacyNames[name] ?? name;
}
