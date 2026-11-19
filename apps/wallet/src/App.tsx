import { BitcoinAccess } from "./bitcoin-access";
import { ResetWallet } from "./reset-wallet";
import { Dropdown } from "@ewallet/ui";
import { displayNetworkName, displayAssetName } from "@ewallet/domain";
import { Discover } from "./discover";
import { AccountsPage } from "./accounts";
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
  LogOut,
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
  RealWelcome as Welcome,
  RealCreate as Create,
  RealImport as Import,
  RealUnlock as Unlock,
} from "./real-onboarding";
import { RealSettings } from "./real-settings";
import { RealApps } from "./real-apps";
import {
  Home,
  AssetDetails,
  TokenManagement,
  Activity,
  Collectibles,
} from "./portfolio";
import { Send, Receive, Contacts } from "./payments";
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
  const { snapshot: s, gateway, notify } = useWallet(),
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
    enabled: !s.locked && Boolean(s.selectedAccountId),
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
          <NavLink to="/services">
            <ShieldCheck size={19} /> Network tools
          </NavLink>
          <NavLink to="/settings">
            <Settings2 size={19} />
            Settings
          </NavLink>
          <NavLink to="/evaluation">
            <FlaskConical size={19} />
            Network status
          </NavLink>
          {__WALLET_MODE__ === "local" && (
            <NavLink to="/accounts">
              <ShieldCheck size={19} /> Credit account
            </NavLink>
          )}
          <Button
            variant="ghost"
            aria-label="Sign out of wallet"
            onClick={async () => {
              gateway.lock();
              try {
                if (__WALLET_MODE__ === "local") {
                  const signal = AbortSignal.timeout(8000);
                  const status = await fetch("/api/v1/accounts/status", {
                    cache: "no-store",
                    signal,
                  });
                  if (!status.ok)
                    throw new Error("Account service unavailable");
                  if ((await status.json()).data.enabled) {
                    const session = await fetch("/api/v1/session", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: "{}",
                      signal,
                    });
                    if (!session.ok) throw new Error("Session unavailable");
                    const token = (await session.json()).data.csrfToken;
                    const logout = await fetch("/api/v1/accounts/logout", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": token,
                      },
                      body: "{}",
                      signal,
                    });
                    if (!logout.ok) throw new Error("Account sign-out failed");
                  }
                }
                notify("Signed out. Your wallet is locked.");
              } catch {
                notify(
                  "Wallet locked. Account sign-out could not finish. Open Credit account to retry signing out.",
                );
              }
            }}
          >
            <LogOut size={18} />{" "}
            <span className="nav-label">Sign out of wallet</span>
          </Button>
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
            Wallet connected
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
            <Dropdown
              id="network"
              value={s.networkId}
              onValueChange={(e) => gateway.selectNetwork(e)}
            >
              {networks
                .filter(
                  (n) =>
                    n.environment === s.mode ||
                    (s.mode === "testnet" && n.family === "bitcoin"),
                )
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {displayNetworkName(n)}
                  </option>
                ))}
            </Dropdown>
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
              <span className="desktop-label">Lock wallet</span>
            </Button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <RouteFocus />
          {s.lastError && s.lastError.code !== "WATCH_CONSENT" && (
            <Notice tone="error">{s.lastError.message}</Notice>
          )}
          {s.bitcoinWatchConsentRequired &&
            networkById(s.networkId).family === "bitcoin" && <BitcoinAccess />}
          <Outlet />
        </main>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={14} /> Your keys, your wallet
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
                  {displayAssetName(asset.name)} <small>{asset.symbol}</small>
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
        description={`Public addresses on ${displayNetworkName(n)}. Different network families have different addresses.`}
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
        <span className="mode-badge">Your wallet, everywhere</span>
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
        {__WALLET_MODE__ === "local" && (
          <Route path="/accounts" element={<AccountsPage />} />
        )}
        <Route element={<OnboardingShell />}>
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/create" element={<Create />} />
          <Route path="/import" element={<Import />} />
          <Route path="/unlock" element={<Unlock />} />
          <Route path="/reset" element={<ResetWallet />} />
        </Route>
        <Route element={<Guard />}>
          <Route element={<Shell />}>
            <Route index element={<Home />} />
            <Route path="/asset" element={<AssetDetails />} />
            <Route path="/tokens" element={<TokenManagement />} />
            <Route path="/send" element={<Send />} />
            <Route path="/receive" element={<Receive />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/collectibles" element={<Collectibles />} />
            <Route path="/apps" element={<RealApps />} />
            <Route path="/services" element={<RealServices />} />
            {(["swap", "bridge", "faucet", "vault", "shared"] as const).map(
              (service) => (
                <Route
                  key={service}
                  path={"/" + service}
                  element={<RealService service={service} />}
                />
              ),
            )}
            <Route path="/settings" element={<RealSettings />} />
            <Route path="/evaluation" element={<RealEvaluation />} />
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
