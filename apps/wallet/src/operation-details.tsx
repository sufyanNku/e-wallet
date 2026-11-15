import { formatAmount, type PreparedOperation } from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import { Address } from "@ewallet/ui";
export function OperationDetails({
  operation: p,
}: {
  operation: PreparedOperation;
}) {
  return (
    <dl className="details">
      <dt>Operation</dt>
      <dd>{p.intent.kind}</dd>
      <dt>Network</dt>
      <dd>{networkById(p.intent.networkId).name}</dd>
      {p.preview.sender && (
        <>
          <dt>Signing account</dt>
          <dd>
            <Address value={p.preview.sender} />
          </dd>
        </>
      )}
      <dt>Full recipient / contract</dt>
      <dd>
        <Address value={p.preview.recipient} />
      </dd>
      <dt>Exact amount (base units)</dt>
      <dd>{p.preview.amount}</dd>
      <dt>Amount</dt>
      <dd>
        {formatAmount(p.preview.amount, p.preview.decimals ?? 0)}{" "}
        {p.preview.assetSymbol ?? "base units"}
      </dd>
      {p.preview.decodedOperation && (
        <>
          <dt>Decoded operation</dt>
          <dd className="decoded-operation">{p.preview.decodedOperation}</dd>
        </>
      )}
      {p.preview.contractAddress && (
        <>
          <dt>Contract</dt>
          <dd>
            <Address value={p.preview.contractAddress} />
          </dd>
        </>
      )}
      {p.preview.nonce !== undefined && (
        <>
          <dt>Nonce</dt>
          <dd>{p.preview.nonce}</dd>
        </>
      )}
      <dt>Estimated fee</dt>
      <dd>
        {formatAmount(p.fee.estimated, p.fee.decimals)} {p.fee.symbol}
      </dd>
      <dt>Maximum fee</dt>
      <dd>
        {formatAmount(p.fee.maximum, p.fee.decimals)} {p.fee.symbol}
      </dd>
      <dt>Expires</dt>
      <dd>{new Date(p.expiresAt).toLocaleTimeString()}</dd>
      <dt>Payload digest</dt>
      <dd>
        <Address value={p.digest} />
      </dd>
    </dl>
  );
}
