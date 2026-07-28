/// <reference types="vite/client" />

interface Window {
  voidcatDesktop?: {
    bridgeVersion: number;
    chooseRagFolder(): Promise<string | null>;
    credentials: {
      set(namespace: string, key: string, value: string): Promise<{ namespace: string; key: string; stored: boolean }>;
      delete(namespace: string, key: string): Promise<boolean>;
      list(namespace: string): Promise<string[]>;
      test(): Promise<{ available: boolean; backend: string }>;
    };
    maritime: {
      start(regionIds?: string[]): Promise<MaritimeDesktopSnapshot>;
      disable(): Promise<MaritimeDesktopSnapshot>;
      stop(): Promise<MaritimeDesktopSnapshot>;
      snapshot(): Promise<MaritimeDesktopSnapshot>;
      setDisplayCadence(displayCadenceMs: number): Promise<{ displayCadenceMs: number }>;
    };
  };
}

type MaritimeDesktopSnapshot = {
  sourceId: string;
  enabled: boolean;
  status: string;
  message: string;
  regionIds: string[];
  activeRegionIds: string[];
  regionLabel: string;
  displayCadenceMs: number;
  connectedAt: string | null;
  lastMessageAt: string | null;
  droppedMessages: number;
  observations: import("../app/hunter-seeker-map-data").HunterSeekerObservation[];
};
