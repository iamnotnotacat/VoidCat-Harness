/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("VoidCat renderer recovery boundary", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="app-recovery-screen" role="alert">
      <span>RENDERER SAFETY BOUNDARY</span>
      <h1>INTERFACE LINK INTERRUPTED</h1>
      <p>{this.state.error.message || "VoidCat encountered an unexpected interface error."}</p>
      <button type="button" onClick={() => window.location.reload()}>RELOAD INTERFACE</button>
    </main>;
  }
}
