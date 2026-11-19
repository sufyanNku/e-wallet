import { displayAssetName, displayNetworkName } from "@ewallet/domain";
import { useEffect, useState, useSyncExternalStore, useRef } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as ScreenCapture from "expo-screen-capture";
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import QRCode from "react-native-qrcode-svg";
import {
  NativeWallet,
  NativeApi,
  type MobileAccount,
} from "@ewallet/native-wallet";
import { networks, networkById } from "@ewallet/config";
import {
  assetKey,
  formatAmount,
  formatUsd,
  demoValue,
  parseAmount,
  type PreparedOperation,
  type TransactionIntent,
  type AssetBalance,
} from "@ewallet/domain";
import { deviceStorage } from "./storage";
import { Button, Coin, Icon, Input, Mark, Note, Row, color, ui } from "./ui";
type Screen =
  | "wallet"
  | "collectibles"
  | "activity"
  | "settings"
  | "welcome"
  | "create"
  | "restore"
  | "receive"
  | "send"
  | "swap"
  | "scan"
  | "discover";
const short = (value: string) =>
  value.length > 20 ? value.slice(0, 9) + "…" + value.slice(-7) : value;
export default function App() {
  const [wallet, setWallet] = useState<NativeWallet | null>(null),
    [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const store = await deviceStorage(),
        api = new NativeApi(
          Constants.expoConfig?.extra?.apiUrl ?? "http://127.0.0.1:8787",
        ),
        w = new NativeWallet(store, (n) => Crypto.getRandomBytes(n), api);
      await w.open();
      if (mounted.current) setWallet(w);
    })().catch(() =>
      setError(
        "Secure storage could not open. Restart the app. Your existing wallet data has not been replaced.",
      ),
    );
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={ui.screen}>
        {wallet ? (
          <WalletApp wallet={wallet} />
        ) : (
          <View style={[ui.content, { flex: 1, justifyContent: "center" }]}>
            <Mark />
            {error ? (
              <Note error>{error}</Note>
            ) : (
              <ActivityIndicator color={color.accent} />
            )}
            <Text style={ui.subtitle}>Your keys stay on this device.</Text>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
function WalletApp({ wallet }: { wallet: NativeWallet }) {
  const s = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot),
    [screen, setScreen] = useState<Screen>("wallet"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [phrase, setPhrase] = useState(""),
    [words, setWords] = useState<string[]>([]),
    [challenge, setChallenge] = useState<number[]>([]),
    [answers, setAnswers] = useState(["", "", ""]),
    [createStep, setCreateStep] = useState(0),
    [ack, setAck] = useState(false),
    [hidden, setHidden] = useState(false),
    [search, setSearch] = useState(""),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState(""),
    [selectedAsset, setSelectedAsset] = useState<string | null>(null),
    [review, setReview] = useState<PreparedOperation | null>(null),
    [sheet, setSheet] = useState<"network" | "account" | null>(null),
    [notice, setNotice] = useState(""),
    [nextPassword, setNextPassword] = useState(""),
    [background, setBackground] = useState(false),
    [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [nftAsset, setNftAsset] = useState<AssetBalance | null>(null);
  const account = s.accounts.find((a) => a.id === s.selectedAccountId),
    network = networkById(s.networkId),
    asset =
      nftAsset ??
      s.balances.find((b) => assetKey(b.asset) === selectedAsset) ??
      s.balances[0];
  const clearSecrets = () => {
    setNftAsset(null);
    setPassword("");
    setConfirm("");
    setPhrase("");
    setWords([]);
    setAnswers(["", "", ""]);
    setCreateStep(0);
    setAck(false);
    setNextPassword("");
    setReview(null);
  };
  useEffect(() => {
    if (s.locked) {
      clearSecrets();
      setScreen("wallet");
    }
  }, [s.locked]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setBackground(true);
        clearSecrets();
        wallet.lock();
      } else setBackground(false);
    });
    const idle = setInterval(() => wallet.tick(), 10000);
    return () => {
      subscription.remove();
      clearInterval(idle);
    };
  }, [wallet]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sensitive =
      background ||
      (s.initialized && s.locked) ||
      ["create", "restore", "settings"].includes(screen);
    const update = sensitive
      ? ScreenCapture.preventScreenCaptureAsync("wallet")
      : ScreenCapture.allowScreenCaptureAsync("wallet");
    void update.catch(() =>
      setError("Screen privacy protection is unavailable on this device."),
    );
    return () => {
      void ScreenCapture.allowScreenCaptureAsync("wallet").catch(() => {});
    };
  }, [screen, s.initialized, s.locked, background]);
  useEffect(() => {
    setNftAsset(null);
    setSelectedAsset(null);
    setReview(null);
  }, [s.networkId, s.selectedAccountId]);
  useEffect(() => {
    if (!s.locked) void wallet.refresh().catch(() => {});
  }, [wallet, s.locked, s.networkId, s.selectedAccountId]);
  useEffect(() => {
    const handler = ({ url }: { url: string }) => {
      try {
        const u = new URL(url);
        if (u.protocol !== "ewallet:" || u.hostname !== "send" || s.locked)
          return;
        const target = u.searchParams.get("to") ?? "";
        if (target.length > 200) return;
        setRecipient(target);
        setAmount("");
        setScreen("send");
        setNotice(
          "Payment link opened. Verify the address and network before continuing.",
        );
      } catch {
        /* Invalid links carry no signing authority. */
      }
    };
    const subscription = Linking.addEventListener("url", handler);
    return () => subscription.remove();
  }, [s.locked]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not complete this action. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function go(next: Screen) {
    wallet.touch();
    if(next==='wallet')setNftAsset(null);
    setError("");
    setNotice("");
    setReview(null);
    setScreen(next);
  }
  const back = () => go("wallet");
  const refresh = () => run(() => wallet.refresh());
  const titles: Partial<Record<Screen, string>> = {
    receive: "Receive",
    send: "Send",
    swap: "Swap",
    activity: "Activity",
    collectibles: "Collectibles",
    discover: "Discover",
    settings: "Settings",
    scan: "Scan a payment",
  };
  async function prepare() {
    if (!asset)
      throw new Error("Refresh your balance before preparing a transfer.");
    const raw = parseAmount(amount, asset.decimals);
    if (BigInt(raw) <= 0n)
      throw new Error("Enter an amount greater than zero.");
    const intent: TransactionIntent = {
      requestId: Crypto.randomUUID(),
      kind: nftAsset ? "nft-transfer" : "send",
      networkId: s.networkId,
      accountId: s.selectedAccountId,
      asset: asset.asset,
      recipient: recipient.trim(),
      amount: String(raw),
    };
    setReview(await wallet.prepare(intent));
  }
  const bottom = [
    "wallet",
    "swap",
    "discover",
    "activity",
    "settings",
  ] as const;
  if (background)
    return (
      <View
        style={[ui.screen, { alignItems: "center", justifyContent: "center" }]}
      >
        <Mark />
        <Text style={[ui.title, { marginTop: 20 }]}>Wallet locked</Text>
      </View>
    );
  if (!s.initialized) {
    return (
      <KeyboardAvoidingView
        style={ui.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[ui.content, { paddingTop: 35 }]}
          keyboardShouldPersistTaps="handled"
        >
          {screen !== "create" && screen !== "restore" ? (
            <>
              <View style={{ marginBottom: 28, marginTop: 45 }}>
                <Mark />
              </View>
              <Text style={[ui.title, { fontSize: 45, lineHeight: 49 }]}>
                Your world.{"\n"}In your wallet.
              </Text>
              <Text style={ui.subtitle}>
                One wallet for your assets, payments and connections. You hold
                the keys.
              </Text>
              <View style={{ height: 35 }} />
              <Button onPress={() => go("create")}>Create a wallet</Button>
              <Button secondary onPress={() => go("restore")}>
                I already have a wallet
              </Button>
              <Text style={[ui.subtitle, { fontSize: 11, marginTop: 24 }]}>
                Your recovery phrase is the only way to restore your wallet.
                Keep it private and offline.
              </Text>
            </>
          ) : (
            <>
              <Pressable
                style={ui.back}
                onPress={() => {
                  clearSecrets();
                  go("welcome");
                }}
              >
                <Icon name="back" />
                <Text style={ui.backText}>Back</Text>
              </Pressable>
              <Text style={ui.title}>
                {screen === "restore"
                  ? "Restore your wallet"
                  : createStep === 0
                    ? "Create your wallet"
                    : createStep === 1
                      ? "Your recovery phrase"
                      : "Check your backup"}
              </Text>
              <Text style={ui.subtitle}>
                {screen === "restore"
                  ? "Your words stay on this device."
                  : "Step " +
                    (createStep + 1) +
                    " of 3 · Keep control of your keys."}
              </Text>
              {screen === "restore" && (
                <Input
                  label="Recovery phrase"
                  value={phrase}
                  onChangeText={setPhrase}
                  multiline
                  textContentType="none"
                  autoComplete="off"
                />
              )}
              {(screen === "restore" || createStep === 0) && (
                <>
                  <Input
                    label="Wallet password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoComplete="new-password"
                  />
                  <Input
                    label="Confirm password"
                    value={confirm}
                    onChangeText={setConfirm}
                    secureTextEntry
                    autoComplete="new-password"
                  />
                  <Text style={ui.subtitle}>
                    Use at least 12 characters. This password unlocks this
                    device.
                  </Text>
                </>
              )}
              {createStep === 1 && (
                <>
                  <Note>
                    Write down all 24 words in order. Anyone with these words
                    can control your assets. Do not take a screenshot.
                  </Note>
                  <View style={styles.words}>
                    {words.map((word, i) => (
                      <View key={i} style={styles.word}>
                        <Text style={styles.wordNumber}>{i + 1}</Text>
                        <Text style={styles.wordText}>{word}</Text>
                      </View>
                    ))}
                  </View>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: ack }}
                    style={styles.ack}
                    onPress={() => setAck(!ack)}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        ack && { backgroundColor: color.accent },
                      ]}
                    >
                      {ack && <Icon name="check" size={16} tint="#2d1c4b" />}
                    </View>
                    <Text style={[ui.subtitle, { flex: 1 }]}>
                      I saved every word in order, offline.
                    </Text>
                  </Pressable>
                </>
              )}
              {createStep === 2 &&
                challenge.map((index, i) => (
                  <Input
                    key={index}
                    label={"Recovery word " + (index + 1)}
                    value={answers[i]}
                    onChangeText={(value) =>
                      setAnswers((a) => a.map((v, j) => (i === j ? value : v)))
                    }
                    autoComplete="off"
                  />
                ))}
              {error && <Note error>{error}</Note>}
              <Button
                disabled={busy || (createStep === 1 && !ack)}
                onPress={() =>
                  void run(async () => {
                    if (screen === "restore") {
                      await wallet.restore(phrase, password, confirm);
                      clearSecrets();
                      go("wallet");
                      return;
                    }
                    if (createStep === 0) {
                      const result = await wallet.create(password, confirm);
                      setWords(result.words);
                      setChallenge(result.challenge);
                      setPassword("");
                      setConfirm("");
                      setCreateStep(1);
                    } else if (createStep === 1) {
                      setWords([]);
                      setCreateStep(2);
                    } else {
                      await wallet.finishBackup(answers);
                      clearSecrets();
                      go("wallet");
                    }
                  })
                }
              >
                {busy
                  ? "Securing your wallet…"
                  : screen === "restore"
                    ? "Restore wallet"
                    : createStep === 2
                      ? "Open wallet"
                      : "Continue"}
              </Button>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }
  if (s.locked)
    return (
      <KeyboardAvoidingView
        style={ui.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[ui.content, { paddingTop: 95 }]}
        >
          <Mark />
          <Text style={[ui.title, { fontSize: 38, marginTop: 20 }]}>
            Welcome back.
          </Text>
          <Text style={ui.subtitle}>Unlock to access your wallet.</Text>
          <Input
            label="Wallet password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            autoComplete="current-password"
            onSubmitEditing={() =>
              void run(async () => {
                await wallet.unlock(password);
                setPassword("");
              })
            }
          />
          {error && <Note error>{error}</Note>}
          <Button
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await wallet.unlock(password);
                setPassword("");
              })
            }
          >
            {busy ? "Unlocking…" : "Unlock wallet"}
          </Button>
          <Note>
            Forgot your password? Keep your recovery phrase safe. Your browser
            wallet is separate from this device.
          </Note>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  return (
    <View style={ui.screen} onTouchStart={() => wallet.touch()}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch account"
          style={styles.account}
          onPress={() => setSheet("account")}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {account?.index !== undefined ? account.index + 1 : "1"}
            </Text>
          </View>
          <View>
            <Text style={styles.accountName}>{account?.name}</Text>
            <Text style={styles.small}>{short(account?.address ?? "")}</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Select network"
          onPress={() => setSheet("network")}
          style={styles.network}
        >
          <View style={styles.dot} />
          <Text numberOfLines={1} style={styles.networkText}>
            {displayNetworkName(network)}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Lock wallet"
          onPress={() => wallet.lock()}
          style={styles.iconButton}
        >
          <Icon name="lock" size={19} />
        </Pressable>
      </View>
      {screen !== "wallet" && (
        <Pressable style={ui.back} onPress={back}>
          <Icon name="back" />
          <Text style={ui.backText}>Wallet</Text>
        </Pressable>
      )}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={ui.content}
          refreshControl={
            screen === "wallet" ? (
              <RefreshControl
                refreshing={busy}
                onRefresh={() => void refresh()}
                tintColor={color.accent}
              />
            ) : undefined
          }
        >
          {screen === "wallet" ? (
            <>
              <View style={styles.balanceHeader}>
                <Text style={ui.subtitle}>Total value</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    hidden ? "Show balances" : "Hide balances"
                  }
                  onPress={() => setHidden(!hidden)}
                  style={styles.iconButton}
                >
                  <Icon name="eye" size={18} tint={color.muted} />
                </Pressable>
              </View>
              <Text style={styles.balance}>
                {hidden
                  ? "••••••"
                  : s.status === "unavailable"
                    ? "Unavailable"
                    : formatUsd(demoValue(s.balances).microUsd)}
              </Text>
              <Text style={styles.balanceCaption}>
                {s.status === "loading"
                  ? "Syncing on-chain balances…"
                  : "Your portfolio"}
              </Text>
              <View style={styles.actions}>
                {[
                  { to: "send", label: "Send", icon: "send" },
                  { to: "receive", label: "Receive", icon: "receive" },
                  { to: "swap", label: "Swap", icon: "swap" },
                  { to: "scan", label: "Scan", icon: "scan" },
                ].map((a) => (
                  <Pressable
                    key={a.to}
                    accessibilityRole="button"
                    onPress={() => go(a.to as Screen)}
                    style={styles.action}
                  >
                    <View style={styles.actionIcon}>
                      <Icon name={a.icon} tint={color.accent} />
                    </View>
                    <Text style={styles.actionLabel}>{a.label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.walletTabs}>
                <Pressable onPress={() => go("wallet")}>
                  <Text style={styles.activeTab}>Tokens</Text>
                </Pressable>
                <Pressable onPress={() => go("collectibles")}>
                  <Text style={styles.tab}>Collectibles</Text>
                </Pressable>
                <Pressable onPress={() => go("activity")}>
                  <Text style={styles.tab}>Activity</Text>
                </Pressable>
              </View>
              {network.family === "bitcoin" && (
                <Note>
                  Bitcoin discovery shares public account descriptors with your
                  configured backend. This reveals receive/change activity,
                  never your private keys.
                  <Button
                    secondary
                    disabled={busy}
                    onPress={() => void run(() => wallet.connectBitcoinWatch())}
                  >
                    Enable public watch discovery
                  </Button>
                </Note>
              )}
              <Input
                label="Search tokens"
                placeholder="Token name or symbol"
                value={search}
                onChangeText={setSearch}
              />
              {s.status === "unavailable" && (
                <Note error>
                  Network unavailable. Previously observed balances are not a
                  live quote. Pull down to retry.
                </Note>
              )}
              {s.balances
                .filter((b) =>
                  (b.name + b.symbol)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((b) => (
                  <Pressable
                    accessibilityRole="button"
                    key={assetKey(b.asset)}
                    onPress={() => {
                      setSelectedAsset(assetKey(b.asset));
                      go("send");
                    }}
                    style={styles.asset}
                  >
                    <Coin symbol={b.symbol} />
                    <View style={{ flex: 1, gap: 5 }}>
                      <Text style={styles.assetName}>{displayAssetName(b.name)}</Text>
                      <Text style={styles.small}>{b.symbol}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 5 }}>
                      <Text style={styles.assetName}>
                        {hidden ? "••••" : formatAmount(b.raw, b.decimals)}
                      </Text>
                      <Text style={styles.small}>
                        {b.microUsdRate === null
                          ? "Unpriced"
                          : hidden
                            ? "••••"
                            : formatUsd(demoValue([b]).microUsd)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              {!s.balances.length && (
                <View style={styles.empty}>
                  <Icon name="wallet" size={34} tint={color.muted} />
                  <Text style={ui.sectionTitle}>
                    {s.status === "loading"
                      ? "Finding your assets…"
                      : "Your wallet starts here"}
                  </Text>
                  <Text style={ui.subtitle}>
                    Choose your network and receive your first assets.
                  </Text>
                  <Button secondary onPress={() => go("receive")}>
                    Receive
                  </Button>
                </View>
              )}
              <Text style={styles.disclaimer}>
                {s.updatedAt
                  ? "Updated " + new Date(s.updatedAt).toLocaleTimeString()
                  : "No balance observation yet"}{" "}
              </Text>
            </>
          ) : (
            <Text style={ui.title}>{titles[screen]}</Text>
          )}
          {screen === "receive" && (
            <>
              <Note>
                Receive only {network.feeAsset.symbol} and supported tokens on{" "}
                {displayNetworkName(network)}. Check the selected network before sharing this address.
              </Note>
              <View style={styles.qr}>
                <QRCode
                  value={
                    network.family === "evm"
                      ? "ethereum:" + account?.address + "@" + network.identity
                      : network.family === "solana"
                        ? "solana:" + account?.address
                        : "bitcoin:" + account?.address
                  }
                  size={220}
                  color="#172016"
                  backgroundColor="#f3f6ed"
                />
              </View>
              <Text selectable style={styles.fullAddress}>
                {account?.address}
              </Text>
              <Button
                onPress={() =>
                  void run(async () => {
                    await Clipboard.setStringAsync(account!.address);
                    await Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Success,
                    );
                    setNotice("Address copied.");
                  })
                }
              >
                Copy address
              </Button>
              <Text style={ui.subtitle}>
                Compare the first and last characters after pasting the address.
              </Text>
            </>
          )}
          {screen === "send" && (
            <>
              <View style={ui.card}>
                <Text style={ui.label}>Pay with</Text>
                {s.balances.map((b) => (
                  <Pressable
                    key={assetKey(b.asset)}
                    style={styles.asset}
                    onPress={() => setSelectedAsset(assetKey(b.asset))}
                  >
                    <Coin symbol={b.symbol} />
                    <Text style={[styles.assetName, { flex: 1 }]}>
                      {b.symbol}
                    </Text>
                    <Text style={styles.small}>
                      {formatAmount(b.raw, b.decimals)}
                    </Text>
                    {assetKey(b.asset) ===
                      assetKey(asset?.asset ?? b.asset) && (
                      <Icon name="check" size={18} tint={color.accent} />
                    )}
                  </Pressable>
                ))}
              </View>
              <Input
                label="Recipient address"
                placeholder="Paste an address"
                value={recipient}
                onChangeText={setRecipient}
              />
              <Input
                label={"Amount" + (asset ? " (" + asset.symbol + ")" : "")}
                placeholder="0.00"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
              />
              <Text style={ui.subtitle}>
                Network: {displayNetworkName(network)}. Network fees are shown before you
                approve.
              </Text>
              <Button
                disabled={busy || !asset || !recipient || !amount}
                onPress={() => void run(prepare)}
              >
                {busy ? "Preparing review…" : "Review payment"}
              </Button>
            </>
          )}
          {screen === "activity" && (
            <>
              {s.activity.length ? (
                s.activity.map((item) => (
                  <View key={item.id} style={styles.asset}>
                    <View style={styles.activityIcon}>
                      <Icon
                        name={
                          item.direction === "incoming" ? "receive" : "send"
                        }
                      />
                    </View>
                    <View style={{ flex: 1, gap: 6 }}>
                      <Text style={styles.assetName}>
                        {item.intent.kind === "send"
                          ? "Sent"
                          : item.intent.kind.replaceAll("-", " ")}
                      </Text>
                      <Text style={styles.small}>
                        {new Date(item.createdAt).toLocaleString()}
                      </Text>
                      <Text selectable style={styles.small}>
                        {item.hash ? short(item.hash) : "Awaiting signature"}
                      </Text>{item.direction==='outgoing'&&!item.id.startsWith('indexed:')&&['signed','submission_unknown','submitted'].includes(item.state)&&<Button secondary disabled={busy} onPress={()=>void run(async()=>{await wallet.retrySubmission(item.id);setNotice('Retried the exact saved transaction. No new transaction was signed.');})}>Retry saved transaction</Button>}
                    </View>
                    <Text
                      style={[
                        styles.small,
                        {
                          color: ["confirmed", "finalized"].includes(item.state)
                            ? color.accent
                            : color.muted,
                        },
                      ]}
                    >
                      {item.state.replaceAll("_", " ")}
                    </Text>
                  </View>
                ))
              ) : (
                <View style={styles.empty}>
                  <Icon name="activity" size={34} tint={color.muted} />
                  <Text style={ui.sectionTitle}>Your story starts here</Text>
                  <Text style={ui.subtitle}>
                    Payments made from this device appear here with their actual
                    network status.
                  </Text>
                </View>
              )}
              {s.history && (
                <Text style={ui.subtitle}>{s.history.coverage}</Text>
              )}
              {s.history?.nextCursor && (
                <Button
                  secondary
                  disabled={busy}
                  onPress={() => void run(() => wallet.loadOlderActivity())}
                >
                  Load older activity
                </Button>
              )}
              <Button secondary disabled={busy} onPress={() => void refresh()}>
                Refresh activity
              </Button>
            </>
          )}
          {screen === "collectibles" && (
            <>
              {s.collectibles.length ? (
                s.collectibles.map((item) => (
                  <View style={ui.card} key={item.id}>
                    <View style={styles.nftArtwork}>
                      <Icon name="image" size={52} tint={color.accent} />
                    </View>
                    <Text style={ui.sectionTitle}>{displayAssetName(item.name)}</Text>
                    <Text selectable style={styles.small}>
                      {short(item.asset.reference)}
                    </Text>
                    <Text style={ui.subtitle}>
                      Ownership verified on {displayNetworkName(network)}. External media is
                      not loaded automatically.
                    </Text>
                    <Button
                      secondary
                      onPress={() => {
                        if (item.transferable === false) {
                          setError(
                            item.unsupportedReason ??
                              "Unsupported collectible.",
                          );
                          return;
                        }
                        setNftAsset({
                          asset: item.asset,
                          name: item.name,
                          symbol: "NFT",
                          decimals: 0,
                          raw: item.quantity,
                          available: item.quantity,
                          reserved: "0",
                          microUsdRate: null,
                          verified: true,
                          hidden: false,
                          stale: false,
                          observation: item.observation,
                        });
                        setAmount("1");
                        setRecipient("");
                        go("send");
                      }}
                    >
                      Transfer
                    </Button>
                  </View>
                ))
              ) : (
                <View style={styles.empty}>
                  <Icon name="image" size={36} tint={color.muted} />
                  <Text style={ui.sectionTitle}>
                    A home for your collection
                  </Text>
                  <Text style={ui.subtitle}>
                    Supported collectibles appear after their ownership is
                    verified on the network.
                  </Text>
                </View>
              )}
            </>
          )}
          {screen === "settings" && (
            <>
              <View style={ui.card}>
                <Text style={ui.sectionTitle}>Security</Text>
                <Row label="Auto-lock" value="5 minutes" />
                <Row label="When app closes" value="Lock immediately" />
                <Row label="Key storage" value="Device keychain" />
                <Row label="Lock wallet" onPress={() => wallet.lock()} />
              </View>
              <View style={ui.card}>
                <Text style={ui.sectionTitle}>Recovery and password</Text>
                <Input
                  label="Current password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                />
                <View style={{ height: 16 }} />
                <Button
                  secondary
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      setWords(await wallet.reveal(password));
                      setPassword("");
                      setTimeout(() => setWords([]), 30000);
                    })
                  }
                >
                  Show recovery phrase
                </Button>
                {words.length > 0 && (
                  <>
                    <Note>
                      Visible for 30 seconds. Store offline; never share these
                      words.
                    </Note>
                    <View style={styles.words}>
                      {words.map((w, i) => (
                        <View style={styles.word} key={i}>
                          <Text style={styles.wordNumber}>{i + 1}</Text>
                          <Text style={styles.wordText}>{w}</Text>
                        </View>
                      ))}
                    </View>
                    <Button secondary onPress={() => setWords([])}>
                      Hide recovery phrase
                    </Button>
                  </>
                )}
                <View style={{ height: 18 }} />
                <Input
                  label="New password"
                  value={nextPassword}
                  onChangeText={setNextPassword}
                  secureTextEntry
                />
                <View style={{ height: 12 }} />
                <Input
                  label="Confirm new password"
                  value={confirm}
                  onChangeText={setConfirm}
                  secureTextEntry
                />
                <View style={{ height: 16 }} />
                <Button
                  secondary
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await wallet.changePassword(
                        password,
                        nextPassword,
                        confirm,
                      );
                      clearSecrets();
                      setNotice("Password updated.");
                    })
                  }
                >
                  Update password
                </Button>
              </View>
              <View style={ui.card}>
                <Text style={ui.sectionTitle}>Network and app</Text>
                <Row
                  label="Network"
                  value={displayNetworkName(network)}
                  onPress={() => setSheet("network")}
                />
                <Row label="Version" value="0.2.0" />
              </View>
              <View style={ui.card}>
                <Text style={ui.sectionTitle}>Remove wallet</Text>
                <Text style={ui.subtitle}>
                  This removes the encrypted wallet from this device. Keep your
                  recovery phrase before continuing.
                </Text>
                <Input
                  label="Type REMOVE to confirm"
                  value={phrase}
                  onChangeText={setPhrase}
                />
                <View style={{ height: 15 }} />
                <Button
                  secondary
                  disabled={busy || phrase !== "REMOVE"}
                  onPress={() =>
                    void run(async () => {
                      await wallet.reset(password);
                      clearSecrets();
                    })
                  }
                >
                  Remove this wallet
                </Button>
              </View>
            </>
          )}
          {screen === "discover" && <MarketWatch wallet={wallet} />}
          {screen === "swap" && (
            <Swap wallet={wallet} busy={busy} run={run} review={setReview} />
          )}
          {screen === "scan" && (
            <>
              {!cameraPermission?.granted ? (
                <>
                  <Note>
                    Camera access is used only to read a payment address.
                    Nothing is uploaded.
                  </Note>
                  <Button onPress={() => void requestCameraPermission()}>
                    Allow camera
                  </Button>
                </>
              ) : (
                <View
                  style={{ height: 330, borderRadius: 22, overflow: "hidden" }}
                >
                  <CameraView
                    style={{ flex: 1 }}
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                    onBarcodeScanned={({ data }) => {
                      try {
                        const cleaned = data.startsWith("ethereum:")
                          ? data.slice(9).split("@")[0].split("?")[0]
                          : data.startsWith("solana:")
                            ? data.slice(7).split("?")[0]
                            : data.startsWith("bitcoin:")
                              ? data.slice(8).split("?")[0]
                              : data;
                        if (cleaned.length > 200) throw new Error();
                        setRecipient(cleaned);
                        setAmount("");
                        go("send");
                        setNotice(
                          "Scanned address. Verify it matches your selected network.",
                        );
                      } catch {
                        setError(
                          "This QR code is not a supported payment address.",
                        );
                      }
                    }}
                  />
                </View>
              )}
              <Text style={ui.subtitle}>
                Scanning fills the recipient only. You review the network,
                amount and fee before signing.
              </Text>
            </>
          )}
          {notice && <Note>{notice}</Note>}
          {error && <Note error>{error}</Note>}
        </ScrollView>
      </KeyboardAvoidingView>
      <View style={styles.bottom}>
        {bottom.map((item) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: screen === item }}
            key={item}
            onPress={() => go(item)}
            style={styles.bottomItem}
          >
            <Icon
              name={item === "discover" ? "compass" : item}
              size={22}
              tint={screen === item ? color.accent : color.muted}
            />
            <Text
              style={[
                styles.bottomLabel,
                screen === item && { color: color.accent },
              ]}
            >
              {item === "wallet"
                ? "Wallet"
                : item.charAt(0).toUpperCase() + item.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>
      <Modal
        transparent
        animationType="slide"
        visible={sheet !== null}
        onRequestClose={() => setSheet(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setSheet(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text style={ui.title}>
              {sheet === "network" ? "Choose network" : "Your accounts"}
            </Text>
            <ScrollView style={{ maxHeight: 450 }}>
              {sheet === "network"
                ? networks.map((n) => (
                    <Row
                      key={n.id}
                      label={displayNetworkName(n)}
                      value={
                        s.networkId === n.id
                          ? "Selected"
                          : "Available"
                      }
                      onPress={() => {
                        wallet.selectNetwork(n.id);
                        setSheet(null);
                      }}
                    />
                  ))
                : s.accounts
                    .filter((a) => a.family === network.family)
                    .map((a: MobileAccount) => (
                      <Row
                        key={a.id}
                        label={
                          a.name + (a.bitcoinType ? " · " + a.bitcoinType : "")
                        }
                        value={short(a.address)}
                        onPress={() => {
                          wallet.selectAccount(a.id);
                          setSheet(null);
                        }}
                      />
                    ))}
            </ScrollView>
            {sheet === "account" && (
              <Button
                secondary
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await wallet.addAccount();
                    setNotice("Account added.");
                  })
                }
              >
                Add account
              </Button>
            )}
            <Button secondary onPress={() => setSheet(null)}>
              Done
            </Button>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal
        transparent
        animationType="slide"
        visible={review !== null}
        onRequestClose={() => {
          wallet.reject();
          setReview(null);
        }}
      >
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={ui.title}>Review transaction</Text>
            {review && (
              <ScrollView style={{ maxHeight: 470 }}>
                <Text style={[styles.balance, { fontSize: 33, marginTop: 20 }]}>
                  {formatAmount(
                    review.preview.amount ?? review.intent.amount,
                    review.preview.decimals ?? 18,
                  )}{" "}
                  {review.preview.assetSymbol}
                </Text>
                <Row
                  label="Network"
                  value={displayNetworkName(networkById(review.intent.networkId))}
                />
                <Row
                  label="From"
                  value={short(review.preview.sender ?? account?.address ?? "")}
                />
                <Text style={ui.label}>To</Text>
                <Text selectable style={styles.fullAddress}>
                  {review.preview.recipient}
                </Text>
                <Row
                  label="Maximum network fee"
                  value={
                    formatAmount(
                      review.fee.maximum ?? review.fee.estimated,
                      review.fee.decimals,
                    ) +
                    " " +
                    review.fee.symbol
                  }
                />
                <Row
                  label="Operation"
                  value={
                    review.preview.decodedOperation ?? review.preview.title
                  }
                />
                {review.preview.warnings.map((warning, i) => (
                  <Note key={i}>{warning}</Note>
                ))}
              </ScrollView>
            )}
            {error && <Note error>{error}</Note>}
            <Button
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  if (!review) return;
                  const record = await wallet.approve(review.id, review.digest);
                  setReview(null);
                  setScreen("activity");
                  setNotice(
                    record.state === "submission_unknown"
                      ? "Submission outcome is unknown. Refresh before retrying; this wallet will not sign a duplicate."
                      : "Transaction submitted. Waiting for network confirmation.",
                  );
                  void Haptics.notificationAsync(
                    Haptics.NotificationFeedbackType.Success,
                  );
                })
              }
            >
              {busy ? "Signing on your device…" : "Confirm and send"}
            </Button>
            <Button
              secondary
              disabled={busy}
              onPress={() => {
                wallet.reject();
                setReview(null);
              }}
            >
              Cancel
            </Button>
          </View>
        </View>
      </Modal>
    </View>
  );
}
function MarketWatch({ wallet }: { wallet: NativeWallet }) {
  const [quotes, setQuotes] = useState<{
      assets: Array<{ symbol: string; name: string; microUsd: string }>;
      observedAt: string | null;
      source: string;
      stale: boolean;
    } | null>(null),
    [error, setError] = useState(false);
  async function load() {
    setError(false);
    try {
      setQuotes(await wallet.api.request("/api/v1/markets"));
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    void load();
  }, [wallet]);
  return (
    <>
      <Text style={ui.subtitle}>
        Live market references.
      </Text>
      <Text style={ui.sectionTitle}>Market watch</Text>
      {quotes?.assets.map((item) => (
        <View style={styles.asset} key={item.symbol}>
          <Coin symbol={item.symbol} />
          <View style={{ flex: 1, gap: 5 }}>
            <Text style={styles.assetName}>{displayAssetName(item.name)}</Text>
            <Text style={styles.small}>{item.symbol}</Text>
          </View>
          <Text style={styles.assetName}>{formatUsd(item.microUsd)}</Text>
        </View>
      ))}
      {!quotes && !error && <ActivityIndicator color={color.accent} />}
      <Text style={ui.subtitle}>
        {quotes?.source ?? "Coinbase spot"}
        {quotes?.observedAt
          ? " · " + new Date(quotes.observedAt).toLocaleTimeString()
          : ""}
      </Text>
      {(error || quotes?.stale) && (
        <Note>Market data is unavailable or stale. Refresh to try again.</Note>
      )}
      <Button secondary onPress={() => void load()}>
        Refresh market watch
      </Button>
    </>
  );
}
function Swap({
  wallet,
  busy,
  run,
  review,
}: {
  wallet: NativeWallet;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  review: (operation: PreparedOperation) => void;
}) {
  const [amount, setAmount] = useState(""),
    [quote, setQuote] = useState<{
      output: string;
      minimum: string;
      outputSymbol: string;
      outputDecimals: number;
      expiresAt: number;
    } | null>(null);
  return (
    <>
      <Text style={ui.subtitle}>
        Swap tokens through the selected pool. Network and contract checks run before every review.
      </Text>
      <Input
        label="You pay (dUSDC)"
        keyboardType="decimal-pad"
        placeholder="0.00"
        value={amount}
        onChangeText={(value) => {
          setAmount(value);
          setQuote(null);
        }}
      />
      <Button
        secondary
        disabled={busy || !amount}
        onPress={() =>
          void run(async () =>
            setQuote(await wallet.quote(String(parseAmount(amount, 6)))),
          )
        }
      >
        Get quote
      </Button>
      {quote && (
        <>
          <View style={ui.card}>
            <Text style={ui.label}>You receive at least</Text>
            <Text style={[ui.title, { marginVertical: 15 }]}>
              {formatAmount(quote.minimum, quote.outputDecimals)}{" "}
              {quote.outputSymbol}
            </Text>
            <Text style={ui.subtitle}>
              0.5% slippage · Quote expires in 30 seconds. Approve the exact
              input allowance first if required.
            </Text>
          </View>
          <Button
            disabled={busy}
            onPress={() =>
              void run(async () =>
                review(
                  await wallet.prepareSwap(String(parseAmount(amount, 6))),
                ),
              )
            }
          >
            Review swap or allowance
          </Button>
        </>
      )}
    </>
  );
}
const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 19,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderBottomWidth: 1,
    borderColor: "#2c332f",
  },
  account: { flexDirection: "row", alignItems: "center", gap: 9, flex: 1 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: "#e0b49b",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 14, fontWeight: "700", color: "#422d21" },
  accountName: { fontSize: 12, color: color.text, fontWeight: "600" },
  small: { fontSize: 10, color: color.muted },
  network: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: 135,
    paddingHorizontal: 9,
    paddingVertical: 10,
    backgroundColor: "#2c263b",
    borderRadius: 10,
  },
  networkText: { fontSize: 10, color: "#dce6d6", flexShrink: 1 },
  dot: { width: 5, height: 5, backgroundColor: color.accent, borderRadius: 3 },
  iconButton: { padding: 10 },
  balanceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  balance: {
    textAlign: "center",
    fontSize: 51,
    letterSpacing: -2.7,
    fontWeight: "500",
    color: color.text,
  },
  balanceCaption: {
    textAlign: "center",
    color: "#bcaace",
    fontSize: 11,
    marginTop: -10,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 19,
  },
  action: { gap: 10, alignItems: "center", minWidth: 60 },
  actionIcon: {
    width: 53,
    height: 53,
    borderRadius: 19,
    backgroundColor: "#372b49",
    borderWidth: 1,
    borderColor: "#59436f",
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { color: color.text, fontSize: 12, fontWeight: "500" },
  walletTabs: {
    flexDirection: "row",
    gap: 30,
    borderBottomWidth: 1,
    borderColor: color.line,
  },
  activeTab: {
    color: color.accent,
    paddingBottom: 16,
    fontSize: 13,
    fontWeight: "600",
    borderBottomWidth: 2,
    borderColor: color.accent,
  },
  tab: { fontSize: 13, color: color.muted, paddingBottom: 16 },
  asset: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 17,
    borderBottomWidth: 1,
    borderColor: color.line,
  },
  assetName: { color: color.text, fontSize: 13, fontWeight: "500" },
  empty: { paddingVertical: 32, alignItems: "center", gap: 17 },
  disclaimer: { fontSize: 10, color: color.muted, marginTop: 10 },
  qr: {
    alignSelf: "center",
    padding: 22,
    borderRadius: 22,
    backgroundColor: "#f3f6ed",
    marginVertical: 15,
  },
  fullAddress: {
    fontSize: 13,
    lineHeight: 23,
    color: color.text,
    textAlign: "center",
    marginVertical: 15,
  },
  bottom: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 13,
    borderTopWidth: 1,
    borderColor: color.line,
    backgroundColor: "#211c2a",
  },
  bottomItem: { alignItems: "center", gap: 7, minWidth: 56, minHeight: 43 },
  bottomLabel: { fontSize: 9, color: color.muted },
  backdrop: {
    flex: 1,
    backgroundColor: "#000000aa",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#25202f",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    paddingBottom: 35,
    gap: 16,
    borderTopWidth: 1,
    borderColor: "#5e4b74",
  },
  sheetHandle: {
    height: 4,
    width: 36,
    backgroundColor: "#66735f",
    borderRadius: 3,
    alignSelf: "center",
    marginBottom: 10,
  },
  words: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginVertical: 15 },
  word: {
    width: "47%",
    backgroundColor: "#31273d",
    padding: 12,
    borderRadius: 10,
    flexDirection: "row",
    gap: 10,
  },
  wordNumber: { color: color.muted, fontSize: 11, minWidth: 15 },
  wordText: { color: color.text, fontSize: 13 },
  ack: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 10,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 1,
    borderColor: color.accent,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
  },
  activityIcon: {
    height: 41,
    width: 41,
    backgroundColor: "#352b43",
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
  },
  nftArtwork: {
    height: 165,
    borderRadius: 14,
    backgroundColor: "#392c4d",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 18,
  },
});
