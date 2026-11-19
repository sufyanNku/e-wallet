import { displayNetworkName } from "@ewallet/domain";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useSearchParams } from "react-router";
import QRCode from "qrcode";
import jsQR from "jsqr";
import {
  assetKey,
  formatAmount,
  parseAmount,
  contactSchema,
} from "@ewallet/domain";
import { networkById } from "@ewallet/config";
import {
  Address,
  Button,
  Empty,
  Field,
  Notice,
  PageTitle,
  Panel,
  Select,
} from "@ewallet/ui";
import { useWallet, useAction } from "./context";
import { validateRecipient } from "./recipient";

export function Send() {
  const { snapshot: s, review, gateway } = useWallet(),
    action = useAction(),
    nav = useNavigate();
  const [params] = useSearchParams();
  const [key, setKey] = useState(
      params.get("asset") ??
        assetKey(
          s.balances[0]?.asset ?? {
            networkId: s.networkId,
            standard: "native",
            reference: "native",
          },
        ),
    ),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState(""),
    [payload, setPayload] = useState("");
  const b = s.balances.find((b) => assetKey(b.asset) === key) ?? s.balances[0];
  function applyPayload(text: string) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { address: text, network: s.networkId };
    }
    if (
      !data ||
      typeof data !== "object" ||
      !("address" in data) ||
      typeof data.address !== "string"
    )
      throw new Error("QR payload must contain an address.");
    if (!("network" in data) || data.network !== s.networkId)
      throw new Error(
        "The payment request belongs to another network. Select that network and review again.",
      );
    validateRecipient(data.address, s.networkId);
    setRecipient(data.address);
    if ("amount" in data && typeof data.amount === "string") {
      parseAmount(data.amount, b?.decimals ?? 18);
      setAmount(data.amount);
    }
  }
  async function scan(file: File | undefined) {
    if (!file) return;
    if (file.size > 5_000_000)
      throw new Error("QR image must be smaller than 5 MB.");
    const image = await createImageBitmap(file);
    try {
      if (image.width > 4096 || image.height > 4096)
        throw new Error("QR image dimensions exceed 4096 pixels.");
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx)
        throw new Error(
          "Image decoding unavailable. Paste the payment request instead.",
        );
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height);
      if (!result) throw new Error("No readable QR code found.");
      setPayload(result.data);
      applyPayload(result.data);
    } finally {
      image.close();
    }
  }
  if (!b)
    return (
      <>
        <PageTitle title="Send" />
        <Empty title="No assets available">
          Receive assets before sending.
        </Empty>
      </>
    );
  return (
    <>
      <PageTitle
        title="Send assets"
        description="Choose the right network. An address alone does not prove a destination network."
      />
      <div className="content-grid">
        <Panel>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                validateRecipient(recipient, s.networkId);
                const tx = await review({
                  requestId: crypto.randomUUID(),
                  accountId: s.selectedAccountId,
                  networkId: s.networkId,
                  kind: "send",
                  recipient,
                  asset: b.asset,
                  amount: parseAmount(amount, b.decimals).toString(),
                });
                if (tx) nav("/activity");
              });
            }}
          >
            <Select
              label="Asset"
              value={assetKey(b.asset)}
              onChange={(e) => setKey(e.target.value)}
            >
              {s.balances
                .filter((b) => !b.hidden)
                .map((b) => (
                  <option value={assetKey(b.asset)} key={assetKey(b.asset)}>
                    {b.symbol} · {formatAmount(b.available, b.decimals)}{" "}
                    available
                  </option>
                ))}
            </Select>
            <Field
              label="Recipient address"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <Select
              label="Choose a saved contact"
              value=""
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="">Select contact…</option>
              {s.contacts
                .filter((c) => c.networkId === s.networkId)
                .map((c) => (
                  <option key={c.id} value={c.address}>
                    {c.name}
                  </option>
                ))}
            </Select>
            <Field
              label={`Amount (${b.symbol})`}
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              hint={`Exact available: ${formatAmount(b.available, b.decimals)} ${b.symbol}`}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  if (s.mode !== "mock") {
                    validateRecipient(recipient, s.networkId);
                    if (!gateway.estimateMaximum)
                      throw new Error("Maximum quoting is unavailable.");
                    const maximum = await gateway.estimateMaximum({
                      requestId: crypto.randomUUID(),
                      accountId: s.selectedAccountId,
                      networkId: s.networkId,
                      kind: "send",
                      recipient,
                      asset: b.asset,
                      amount: "1",
                    });
                    setAmount(formatAmount(maximum, b.decimals));
                    return;
                  }
                  const n = networkById(s.networkId);
                  const reserve =
                    b.asset.standard === "native"
                      ? (10n ** BigInt(Math.max(0, n.feeAsset.decimals - 4)) *
                          12n) /
                        10n
                      : 0n;
                  const max = BigInt(b.available) - reserve;
                  if (max <= 0n)
                    throw new Error(
                      "No spendable balance after the network fee reserve.",
                    );
                  setAmount(formatAmount(max, b.decimals));
                })
              }
            >
              {s.mode === "mock"
                ? "Use max (with network fee reserve)"
                : "Use max with current fee reserve"}
            </Button>
            <Notice>
              Network: {displayNetworkName(networkById(s.networkId))}. A complete fee preview
              appears before approval.
            </Notice>
            {action.error && <Notice tone="error">{action.error}</Notice>}
            <Button type="submit" disabled={action.busy}>
              {action.busy ? "Preparing…" : "Review payment"}
            </Button>
          </form>
        </Panel>
        <Panel>
          <h2>Payment request</h2>
          <p className="muted">
            Paste a request or upload a QR image. Scanning only fills the form;
            you still review the payment.
          </p>
          <label className="field">
            QR or address text
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={4}
              spellCheck={false}
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => void action.run(() => applyPayload(payload))}
          >
            Read pasted request
          </Button>
          <label className="field file-field">
            Upload QR image
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => void action.run(() => scan(e.target.files?.[0]))}
            />
          </label>
          <p className="muted small">Camera permission is not required.</p>
        </Panel>
      </div>
    </>
  );
}
export function Receive() {
  const { snapshot: s, gateway, notify } = useWallet(),
    action = useAction();
  const [type, setType] = useState<"p2wpkh" | "p2tr">(
      s.accounts
        .find((a) => a.id === s.selectedAccountId)
        ?.path.startsWith("m/86'")
        ? "p2tr"
        : "p2wpkh",
    ),
    [amount, setAmount] = useState(""),
    [qr, setQr] = useState("");
  let received: { address: string; payload: string } | null = null;
  let error = "";
  try {
    received = gateway.receive(type, amount);
  } catch (e) {
    error = e instanceof Error ? e.message : "Invalid receive request";
  }
  const request = received?.payload ?? "";
  useEffect(() => {
    let cancelled = false;
    if (request)
      void QRCode.toDataURL(request, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "M",
      }).then((url) => {
        if (!cancelled) setQr(url);
      });
    else setQr("");
    return () => {
      cancelled = true;
    };
  }, [request]);
  return (
    <>
      <PageTitle
        title="Receive assets"
        description="Share your address together with its network."
      />
      <Panel className="receive-panel">
        <h2>{displayNetworkName(networkById(s.networkId))}</h2>
        {networkById(s.networkId).family === "bitcoin" && (
          <Select
            label="Bitcoin receive address type"
            value={type}
            onChange={(e) => {
              const type = e.target.value as "p2wpkh" | "p2tr";
              setType(type);
              if (s.mode !== "mock") {
                const current = s.accounts.find(
                    (a) => a.id === s.selectedAccountId,
                  ),
                  matching = s.accounts.find(
                    (a) =>
                      a.family === "bitcoin" &&
                      a.index === current?.index &&
                      a.path.startsWith(type === "p2tr" ? "m/86'" : "m/84'"),
                  );
                if (matching) gateway.selectAccount(matching.id);
              }
            }}
          >
            <option value="p2wpkh">Native SegWit · P2WPKH</option>
            <option value="p2tr">Taproot · P2TR</option>
          </Select>
        )}
        {qr && (
          <img
            className="qr"
            src={qr}
            width={280}
            height={280}
            alt="QR code of the reviewed receive request"
          />
        )}
        <Notice tone="warning">
          Only receive supported assets on the selected network.
        </Notice>
        {received && (
          <>
            <Address value={received.address} />
            <div className="form-actions">
              <Button
                onClick={() =>
                  void action.run(async () => {
                    await navigator.clipboard.writeText(received.address);
                    notify("Address copied.");
                  })
                }
              >
                Copy address
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void action.run(async () => {
                    await navigator.clipboard.writeText(received.payload);
                    notify("Payment request copied.");
                  })
                }
              >
                Copy request
              </Button>
            </div>
          </>
        )}
        {s.mode !== "mock" && s.networkId === "bitcoin:regtest" && (
          <Button
            variant="secondary"
            disabled={action.busy}
            onClick={() => void action.run(() => gateway.newBitcoinReceive?.())}
          >
            Generate next receive address
          </Button>
        )}
        <Field
          label="Optional requested amount"
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
        {(error || action.error) && (
          <Notice tone="error">{error || action.error}</Notice>
        )}
      </Panel>
    </>
  );
}
export function Contacts() {
  const { snapshot: s, gateway } = useWallet(),
    action = useAction();
  const [id, setId] = useState("");
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<{ name: string; address: string }>({
    resolver: zodResolver(contactSchema.pick({ name: true, address: true })),
    defaultValues: { name: "", address: "" },
  });
  return (
    <>
      <PageTitle
        title="Contacts"
        description="Contacts are bound to a network. Confirm the network with the recipient."
      />
      <div className="content-grid">
        <Panel>
          <h2>Saved contacts</h2>
          {s.contacts
            .filter((c) => c.networkId === s.networkId)
            .map((c) => (
              <div className="contact" key={c.id}>
                <strong>{c.name}</strong>
                <Address value={c.address} />
                <div className="form-actions">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setId(c.id);
                      reset({ name: c.name, address: c.address });
                    }}
                  >
                    Edit {c.name}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => gateway.deleteContact(c.id)}
                  >
                    Delete {c.name}
                  </Button>
                </div>
              </div>
            ))}
          {!s.contacts.some((c) => c.networkId === s.networkId) && (
            <Empty title="No contacts here yet">
              Add a label and address for this network.
            </Empty>
          )}
        </Panel>
        <Panel>
          <h2>{id ? "Edit contact" : "Add contact"}</h2>
          <form
            onSubmit={handleSubmit((values) =>
              action.run(() => {
                gateway.saveContact(
                  contactSchema.parse({
                    id: id || crypto.randomUUID(),
                    ...values,
                    networkId: s.networkId,
                  }),
                );
                setId("");
                reset();
              }),
            )}
          >
            <Field
              label="Contact label"
              {...register("name")}
              error={errors.name?.message}
              maxLength={60}
            />
            <Field
              label="Full address"
              {...register("address")}
              error={errors.address?.message}
              spellCheck={false}
            />
            <p className="muted">Network: {displayNetworkName(networkById(s.networkId))}</p>
            {action.error && <Notice tone="error">{action.error}</Notice>}
            <Button type="submit">Save contact</Button>
            {id && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setId("");
                  reset();
                }}
              >
                Cancel edit
              </Button>
            )}
          </form>
        </Panel>
      </div>
    </>
  );
}
