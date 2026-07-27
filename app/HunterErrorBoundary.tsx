import { Component, type ErrorInfo, type ReactNode } from "react";

export class HunterErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Hunter-Seeker renderer failure", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <section className="phase-panel hunter-panel"><div className="hunter-error"><strong>HUNTER-SEEKER DISPLAY RECOVERY</strong><span>The situation board stopped rendering. Other VoidCat screens remain available.</span><button className="primary-action" onClick={() => window.location.reload()} type="button">RESTORE BOARD</button></div></section>;
    }
    return this.props.children;
  }
}
