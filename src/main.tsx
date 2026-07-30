/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotificationProvider } from "../app/NotificationCenter";
import { VoidCatConsole } from "../app/VoidCatConsole";
import { AppErrorBoundary } from "../app/AppErrorBoundary";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <NotificationProvider>
        <VoidCatConsole />
      </NotificationProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
