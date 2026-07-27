import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { voidcatLocal } from "./build/voidcat-local-plugin";

export default defineConfig({
  plugins: [react(), voidcatLocal()],
});
