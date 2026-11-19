import { Discover } from "./discover";
import { RealEvaluation } from "./real-evaluation";
import { ConnectPage } from "./connect-page";
import { RealService, RealServices } from "./real-services";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  WalletCards,
  LayoutDashboard,
  Image,
  History,
  PanelsTopLeft,
  Settings2,
  FlaskConical,
  LockKeyhole,
  Plus,
  ArrowLeftRight,
  ShieldCheck,
  Search,
  Bell,
  ChevronRight,
  Command,
} from "lucide-react";
import { networks, networkById } from "@ewallet/config";
import { Address, Button, Field, Modal, Notice } from "@ewallet/ui";
import { useWallet, useAction } from "./context";
import { useUiState } from "./ui-state";
import {
  Welcome as MockWelcome,
  Create as MockCreate,
  Import as MockImport,
  Unlock as MockUnlock,
} from "./onboarding";
import {
  RealWelcome,
  RealCreate,
  RealImport,
  RealUnlock,
} from "./real-onboarding";
import { RealSettings } from "./real-settings";
import { RealApps } from "./real-apps";
const [Welcome, Create, Import, Unlock] =
  __WALLET_MODE__ === "mock"
    ? [MockWelcome, MockCreate, MockImport, MockUnlock]
    : [RealWelcome, RealCreate, RealImport, RealUnlock];
import {
  Home,
  AssetDetails,
  TokenManagement,
  Activity,
  Collectibles,
  ConnectedApps,
  ConnectionApproval,
} from "./portfolio";
import { Send, Receive, Contacts } from "./payments";
import {
  Services,
  Faucet,
  Swap,
  Bridge,
  SavingsVault,
  SharedWallet,
} from "./services";
import { Settings, Evaluation } from "./settings";
const navigation = [
  { to: "/", label: "Wallet", icon: LayoutDashboard },
  { to: "/swap", label: "Swap", icon: ArrowLeftRight },
  { to: "/collectibles", label: "Collectibles", icon: Image },
  { to: "/activity", label: "Activity", icon: History },
  { to: "/apps", label: "Connected apps", icon: PanelsTopLeft },

  { to: "/discover", label: "Discover", icon: Search },
];
function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.getElementById("main-content")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}
function Guard() {
  const { snapshot: s } = useWallet();
  return !s.initialized ? (
    <Navigate to="/welcome" replace />
  ) : s.locked ? (
    <Navigate to="/unlock" replace />
  ) : (
    <Outlet />
  );
}
function Shell() {
  const { snapshot: s, gateway } = useWallet(),
    action = useAction();
  const accountOpen = useUiState((v) => v.accountsOpen),
    setAccountOpen = useUiState((v) => v.setAccountsOpen);
  const [name, setName] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useQuery({
    queryKey: ["portfolio", s.mode, s.selectedAccountId, s.networkId],
    queryFn: async () => {
      await gateway.refresh();
      return true;
    },
    enabled: s.mode !== "mock" && !s.locked && Boolean(s.selectedAccountId),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const n = networkById(s.networkId),
    account = s.accounts.find((a) => a.id === s.selectedAccountId);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-mark product-mark" aria-hidden="true">
            e
          </span>
          e-wallet<span className="brand-dot">.</span>
        </Link>
        <div className="workspace-label">YOUR WALLET, EVERYWHERE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="custody-note">
            <span className="connection-dot" /> Keys held by you
            <p>Encrypted on this device.</p>
          </div>
          <NavLink to="/contacts">
            <WalletCards size={19} /> Address book
          </NavLink>
          <NavLink to="/services"><ShieldCheck size={19} /> Network tools</NavLink>
          <NavLink to="/settings">
            <Settings2 size={19} />
            Settings
          </NavLink>
          <NavLink to="/evaluation">
            <FlaskConical size={19} />
            Network status
          </NavLink>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <Link className="mobile-brand" to="/">
            <WalletCards />
            e-wallet
          </Link>
          <div className="mode-badge">
            <span />
            {s.mode === "mock"
              ? "Mock preview"
              : s.mode === "local"
                ? "Local chains"
                : "Public testnets"}
            <span className="mode-extra"> · Test assets only</span>
          </div>
          <div className="selectors">
            <Button
              variant="ghost"
              aria-label="Search wallet"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={19} />
              <kbd className="desktop-label">⌘ K</kbd>
            </Button>
            <Button
              variant="ghost"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen(true)}
            >
              <Bell size={19} />
            </Button>
            <label className="sr-only" htmlFor="network">
              Selected network
            </label>
            <select
              id="network"
              value={s.networkId}
              onChange={(e) => gateway.selectNetwork(e.target.value)}
            >
              {networks
                .filter(
                  (n) =>
                    s.mode === "mock" ||
                    n.environment === s.mode ||
                    (s.mode === "testnet" && n.family === "bitcoin"),
                )
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
            <Button
              variant="secondary"
              onClick={() => setAccountOpen(true)}
              aria-label="Manage accounts"
            >
              <span className="account-avatar">
                {account?.name.slice(0, 1)}
              </span>
              <span className="account-label">{account?.name}</span>
            </Button>
            <Button
              variant="ghost"
              aria-label="Lock wallet"
              onClick={() => gateway.lock()}
            >
              <LockKeyhole size={19} />
            </Button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <RouteFocus />
          {s.lastError && <Notice tone="error">{s.lastError.message}</Notice>}
          <Outlet />
        </main>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={14} /> Browser wallet ·{" "}
            {s.mode === "mock" ? "Sample data only" : "Test networks only"}
          </span>
          <span>Your recovery is your responsibility.</span>
        </footer>
      </div>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        {[
          { to: "/", label: "Wallet", icon: WalletCards },
          { to: "/activity", label: "Activity", icon: History },
          { to: "/swap", label: "Swap", icon: ArrowLeftRight },
          { to: "/discover", label: "Discover", icon: Search },
          { to: "/settings", label: "Settings", icon: Settings2 },
        ].map(({ to, label, icon: Icon }) => (
          <NavLink to={to} end={to === "/"} key={to}>
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <Modal
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setSearch("");
        }}
        title="Search your wallet"
        description="Find an asset or jump to a wallet action."
      >
        <Field
          label="Search assets and actions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          placeholder="Token, network, or action…"
        />
        <div className="command-results">
          {navigation
            .concat([
              { to: "/send", label: "Send a payment", icon: ArrowLeftRight },
              { to: "/receive", label: "Receive crypto", icon: WalletCards },
              {
                to: "/settings",
                label: "Settings and recovery",
                icon: Settings2,
              },
            ])
            .filter((item) =>
              item.label.toLowerCase().includes(search.toLowerCase()),
            )
            .map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} onClick={() => setSearchOpen(false)}>
                <Icon size={19} />
                <span>{label}</span>
                <ChevronRight size={15} />
              </Link>
            ))}
          {s.balances
            .filter(
              (asset) =>
                !asset.hidden &&
                (asset.name + asset.symbol)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((asset) => (
              <Link
                key={asset.asset.reference}
                to={
                  "/asset?key=" +
                  encodeURIComponent(
                    [
                      asset.asset.networkId,
                      asset.asset.standard,
                      asset.asset.reference,
                      asset.asset.tokenId ?? "",
                    ].join("/"),
                  )
                }
                onClick={() => setSearchOpen(false)}
              >
                <Search size={19} />
                <span>
                  {asset.name} <small>{asset.symbol}</small>
                </span>
                <ChevronRight size={15} />
              </Link>
            ))}
        </div>
        <p className="muted small">
          <Command size={12} /> K opens search from anywhere.
        </p>
      </Modal>
      <Modal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        title="Notifications"
        description="Recent transaction updates for this account."
      >
        {s.activity.length ? (
          s.activity.slice(0, 8).map((item) => (
            <Link
              className="notification-row"
              key={item.id}
              to="/activity"
              onClick={() => setNotificationsOpen(false)}
            >
              <span className="notification-dot" />
              <span>
                <strong>{item.intent.kind.replaceAll("-", " ")}</strong>
                <small>
                  {item.state.replaceAll("_", " ")} ·{" "}
                  {new Date(item.createdAt).toLocaleString()}
                </small>
              </span>
              <ChevronRight size={16} />
            </Link>
          ))
        ) : (
          <div className="empty">
            <Bell size={28} />
            <h3>You're all caught up</h3>
            <p>Transaction updates will appear here.</p>
          </div>
        )}
      </Modal>
      <Modal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title="Your accounts"
        description={`Public ${s.mode === "mock" ? "sample " : ""}addresses on ${n.name}. Different network families have different addresses.`}
      >
        {s.accounts
          .filter((a) => a.family === n.family)
          .map((a) => (
            <div className="account-row" key={a.id}>
              <Button
                variant={a.id === s.selectedAccountId ? "primary" : "secondary"}
                onClick={() => {
                  gateway.selectAccount(a.id);
                  setAccountOpen(false);
                }}
              >
                {a.name} · {a.index + 1}
              </Button>
              <Address value={a.address} />
              <small className="muted">{a.path}</small>
              <Button
                variant="ghost"
                onClick={() =>
                  void action.run(() => {
                    if (!name)
                      throw new Error("Enter the new name below first.");
                    gateway.renameAccount(a.id, name);
                    setName("");
                  })
                }
              >
                Rename using name below
              </Button>
            </div>
          ))}
        <Field
          label="Account name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
        />
        <Button
          variant="secondary"
          onClick={() =>
            void action.run(async () => {
              await gateway.addAccount(name);
              setName("");
            })
          }
        >
          <Plus size={17} /> Add derived account
        </Button>
        {action.error && <Notice tone="error">{action.error}</Notice>}
      </Modal>
    </div>
  );
}
function OnboardingShell() {
  return (
    <div className="onboarding-shell">
      <header>
        <Link className="brand" to="/welcome">
          <WalletCards size={26} />
          e-wallet.
        </Link>
        <span className="mode-badge">
          {__WALLET_MODE__ === "mock"
            ? "Mock preview"
            : __WALLET_MODE__ === "local"
              ? "Local chains"
              : "Public testnets"}{" "}
          · Test only
        </span>
      </header>
      <main id="main-content" tabIndex={-1}>
        <RouteFocus />
        <Outlet />
      </main>
    </div>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {__WALLET_MODE__ !== "mock" && (
          <Route element={<OnboardingShell />}>
            <Route path="/connect" element={<ConnectPage />} />
          </Route>
        )}
        <Route element={<OnboardingShell />}>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/create" element={<Create />} />
          <Route path="/import" element={<Import />} />
          <Route path="/unlock" element={<Unlock />} />
        </Route>
        <Route element={<Guard />}>
          <Route element={<Shell />}>
            <Route index element={<Home />} />
            {__WALLET_MODE__ === "mock" && (
              <Route path="/connect" element={<ConnectionApproval />} />
            )}
            <Route path="/asset" element={<AssetDetails />} />
            <Route path="/tokens" element={<TokenManagement />} />
            <Route path="/send" element={<Send />} />
            <Route path="/receive" element={<Receive />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/collectibles" element={<Collectibles />} />
            <Route
              path="/apps"
              element={
                __WALLET_MODE__ === "mock" ? <ConnectedApps /> : <RealApps />
              }
            />
            <Route
              path="/services"
              element={
                __WALLET_MODE__ === "mock" ? <Services /> : <RealServices />
              }
            />
            <Route
              path="/swap"
              element={
                __WALLET_MODE__ === "mock" ? (
                  <Swap />
                ) : (
                  <RealService service="swap" />
                )
              }
            />
            <Route
              path="/bridge"
              element={
                __WALLET_MODE__ === "mock" ? (
                  <Bridge />
                ) : (
                  <RealService service="bridge" />
                )
              }
            />
            <Route
              path="/faucet"
              element={
                __WALLET_MODE__ === "mock" ? (
                  <Faucet />
                ) : (
                  <RealService service="faucet" />
                )
              }
            />
            <Route
              path="/vault"
              element={
                __WALLET_MODE__ === "mock" ? (
                  <SavingsVault />
                ) : (
                  <RealService service="vault" />
                )
              }
            />
            <Route
              path="/shared"
              element={
                __WALLET_MODE__ === "mock" ? (
                  <SharedWallet />
                ) : (
                  <RealService service="shared" />
                )
              }
            />
            <Route
              path="/settings"
              element={
                __WALLET_MODE__ === "mock" ? <Settings /> : <RealSettings />
              }
            />
            <Route
              path="/evaluation"
              element={
                __WALLET_MODE__ === "mock" ? <Evaluation /> : <RealEvaluation />
              }
            />
            <Route
              path="*"
              element={
                <div>
                  <h1>Page not found</h1>
                  <Link to="/">Return to wallet</Link>
                </div>
              }
            />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
