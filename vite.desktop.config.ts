import { defineConfig } from "vite";
import { voidcatLocal } from "./build/voidcat-local-plugin";

export default defineConfig({
  plugins: [voidcatLocal()],
  preview: { host: "127.0.0.1", port: 4177, strictPort: true },
});
