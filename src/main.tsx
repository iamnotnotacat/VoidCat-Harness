import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NotificationProvider } from "../app/NotificationCenter";
import { VoidCatConsole } from "../app/VoidCatConsole";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NotificationProvider>
      <VoidCatConsole />
    </NotificationProvider>
  </StrictMode>,
);
