/// <reference types="vite/client" />

interface Window {
  voidcatDesktop?: {
    chooseRagFolder(): Promise<string | null>;
  };
}
