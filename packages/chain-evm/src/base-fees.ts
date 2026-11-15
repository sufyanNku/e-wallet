import { Interface, getBytes } from "ethers";
import { WalletError } from "@ewallet/domain";
const oracle = "0x420000000000000000000000000000000000000F",
  iface = new Interface([
    "function isFjord() view returns(bool)",
    "function getL1FeeUpperBound(uint256) view returns(uint256)",
    "function getOperatorFee(uint256) view returns(uint256)",
  ]);
export async function quoteBaseFees(
  provider: { send: (method: string, params: unknown[]) => Promise<unknown> },
  unsignedTransaction: string,
  gasLimit: bigint,
  blockTag = "latest",
) {
  try {
    const chain = BigInt(String(await provider.send("eth_chainId", [])));
    if (chain !== 84532n) throw new Error("Wrong Base chain");
    const call = async (name: string, args: unknown[] = []) =>
      iface.decodeFunctionResult(
        name,
        String(
          await provider.send("eth_call", [
            { to: oracle, data: iface.encodeFunctionData(name, args) },
            blockTag,
          ]),
        ),
      )[0];
    if (!(await call("isFjord")))
      throw new Error("Fjord fee oracle is unavailable");
    const l1 = BigInt(
        await call("getL1FeeUpperBound", [
          getBytes(unsignedTransaction).length,
        ]),
      ),
      operator = BigInt(await call("getOperatorFee", [gasLimit]));
    if (l1 < 0n || operator < 0n) throw new Error("Invalid Base fee");
    return {
      l1Fee: l1,
      operatorFee: operator,
      maximumExtra: (l1 + operator) * 2n,
      oracle,
      blockTag,
    };
  } catch {
    throw new WalletError(
      "FEES_UNAVAILABLE",
      "Complete Base L1 data and operator fee estimates are unavailable. Request a fresh quote.",
    );
  }
}
export async function observedBaseOperatorFee(
  provider: { send: (method: string, params: unknown[]) => Promise<unknown> },
  gasUsed: bigint,
  blockTag: string,
) {
  return BigInt(
    iface.decodeFunctionResult(
      "getOperatorFee",
      String(
        await provider.send("eth_call", [
          {
            to: oracle,
            data: iface.encodeFunctionData("getOperatorFee", [gasUsed]),
          },
          blockTag,
        ]),
      ),
    )[0],
  );
}
