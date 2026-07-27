import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VoidCatConsole } from "../app/VoidCatConsole";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VoidCatConsole />
  </StrictMode>,
);
