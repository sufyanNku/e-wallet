import { networkById } from "@ewallet/config";
import { WalletError } from "@ewallet/domain";
function fail(code: string, message: string): never {
  throw new WalletError(code, message);
}
export function validateRecipient(address: string, networkId: string) {
  const f = networkById(networkId).family;
  if (f === "evm" && !/^0x[0-9a-fA-F]{40}$/.test(address))
    fail("RECIPIENT", "Enter a complete EVM address for the selected network.");
  if (f === "evm" && /^0x0{40}$/.test(address))
    fail("RECIPIENT", "The zero address is not a supported recipient.");
  if (f === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    fail("RECIPIENT", "Enter a Solana address.");
  if (f === "bitcoin" && !/^bcrt1[ac-hj-np-z02-9]{20,90}$/.test(address))
    fail("RECIPIENT", "This mock requires a Bitcoin regtest address (bcrt1).");
}
