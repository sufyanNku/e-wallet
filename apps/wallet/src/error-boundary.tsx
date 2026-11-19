import { Component, type PropsWithChildren } from "react";
export class WalletErrorBoundary extends Component<
  PropsWithChildren<{ lock: () => void }>,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.lock();
  }
  render() {
    return this.state.failed ? (
      <div className="onboarding-shell">
        <main className="onboarding">
          <div className="welcome-mark">e</div>
          <h1>Your wallet is locked.</h1>
          <p className="intro">
            Something interrupted this session. Reload to reconnect and unlock.
            Your encrypted wallet remains on this device.
          </p>
          <button
            className="button primary"
            onClick={() => window.location.reload()}
          >
            Reload wallet
          </button>
        </main>
      </div>
    ) : (
      this.props.children
    );
  }
}
