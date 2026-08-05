/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
/// <reference types="vite/client" />

interface Window {
  voidcatDesktop?: {
    bridgeVersion: number;
    external: {
      open(url: string): Promise<{ opened: boolean; cancelled: boolean; url: string }>;
    };
    docs: {
      openHowToUse(): Promise<{ opened: true; path: string }>;
    };
    chooseRagFolder(): Promise<string | null>;
    models: {
      status(): Promise<ModelLibraryDesktopStatus>;
      choosePrimaryFolder(): Promise<ModelLibraryDesktopStatus>;
      chooseScanFolder(): Promise<ModelLibraryDesktopStatus>;
      removeScanFolder(folder: string): Promise<ModelLibraryDesktopStatus>;
      scan(input: { mode: "targeted" | "full"; root?: string }): Promise<ModelLibraryDesktopStatus>;
      cancelScan(): Promise<{ cancelled: boolean }>;
    };
    credentials: {
      set(namespace: string, key: string, value: string): Promise<{ namespace: string; key: string; stored: boolean }>;
      delete(namespace: string, key: string): Promise<boolean>;
      list(namespace: string): Promise<string[]>;
      describe(namespace: string, key: string): Promise<{ stored: boolean; fingerprint: string | null; updatedAt: string | null }>;
      test(): Promise<{ available: boolean; backend: string }>;
    };
    maritime: {
      testCredential(credential: string, regionIds?: string[]): Promise<{ valid: true; regionIds: string[]; verifiedBy: string }>;
      testSavedCredential(regionIds?: string[]): Promise<{ valid: true; regionIds: string[]; verifiedBy: string }>;
      start(regionIds?: string[]): Promise<MaritimeDesktopSnapshot>;
      disable(): Promise<MaritimeDesktopSnapshot>;
      stop(): Promise<MaritimeDesktopSnapshot>;
      snapshot(): Promise<MaritimeDesktopSnapshot>;
      setDisplayCadence(displayCadenceMs: number): Promise<{ displayCadenceMs: number }>;
    };
    webcams: {
      status(): Promise<PublicWebcamDesktopStatus>;
      configure(credential: string): Promise<PublicWebcamDesktopStatus & { valid: true; verifiedBy: string }>;
      remove(): Promise<PublicWebcamDesktopStatus>;
      discoverRegions(): Promise<PublicWebcamDiscoveryResult>;
      loadRegion(regionId: string): Promise<PublicWebcamRegionResult>;
    };
    windyWebcams: {
      status(): Promise<PublicWebcamDesktopStatus>;
      configure(credential: string): Promise<PublicWebcamDesktopStatus & { valid: true; verifiedBy: string }>;
      remove(): Promise<PublicWebcamDesktopStatus>;
      loadRegion(regionId: string): Promise<PublicWebcamRegionResult>;
    };
    osint: {
      status(): Promise<{ providers: OsintProviderDesktopStatus[] }>;
      configure(providerId: string, values: Record<string, string>): Promise<{ configured: boolean; fingerprint: string | null; updatedAt: string | null }>;
      remove(providerId: string): Promise<{ configured: boolean; fingerprint: string | null; updatedAt: string | null }>;
      test(providerId: string): Promise<{ ok: true; providerId: string }>;
    };
    voice: {
      status(): Promise<VoiceDesktopStatus>;
      chooseExecutable(): Promise<VoiceDesktopStatus>;
      chooseModel(): Promise<VoiceDesktopStatus>;
      transcribe(audioBytes: ArrayBuffer): Promise<{ text: string; local: true; engine: string }>;
      speak(input: { text: string; profile: VoiceProfile; speed: number; outputDeviceId?: string }): Promise<{ spoken: boolean }>;
      stop(): Promise<{ stopped: true }>;
    };
    lan: {
      status(): Promise<LanDesktopStatus>;
      configure(enabled: boolean): Promise<LanDesktopStatus>;
    };
  };
}

type VoiceProfile = "computer-male" | "computer-female" | "tactical-commander" | "high-energy-pilot";
type VoiceDesktopStatus = { local: true; bundled: boolean; ttsAvailable: boolean; transcriptionAvailable: boolean; executableConfigured: boolean; modelConfigured: boolean; executableName: string | null; modelName: string | null; outputDevices: Array<{ id: string; label: string }>; outputDeviceError: string | null };
type LanDesktopStatus = { enabled: boolean; authentication: "required"; token: string | null; urls: string[]; restartRequired: boolean };
type ModelLibraryDesktopStatus = {
  version: number;
  primaryFolder: string;
  scanFolders: string[];
  catalogPath: string;
  compatibleModels: number;
  scan: {
    active: boolean;
    mode?: "targeted" | "full";
    roots?: string[];
    currentPath?: string;
    directoriesScanned?: number;
    filesScanned?: number;
    modelsFound?: number;
    compatibleModels?: number;
    startedAt?: string;
    completedAt?: string;
    cancelled?: boolean;
    cancellable?: boolean;
    error?: string;
  };
};

type OsintProviderDesktopStatus = {
  id: string;
  label: string;
  configured: boolean;
  fingerprint: string | null;
  updatedAt: string | null;
  cacheEntries: number;
  lastRequestAt: string | null;
  nextAllowedAt: string | null;
  lastStatus: string;
  lastError: string | null;
};

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
  errorRate: number;
  recordsPerHour: number;
  expectedBaseline: number;
  silentZero: boolean;
  aiContextEligible: boolean;
  observations: import("../app/hunter-seeker-map-data").HunterSeekerObservation[];
};

type PublicWebcamDesktopStatus = { configured: boolean; fingerprint: string | null; updatedAt: string | null; cachedRegions: number; discoveryCached?: boolean; regionSearchesRemaining?: number };
type PublicWebcamDiscoveryResult = {
  fetchedAt: string;
  providerCandidates: number;
  confirmedLiveStreams: number;
  returned: number;
  truncated: boolean;
  cacheState: "live" | "cached";
  provider: string;
  coverageLimitation: string;
  regionSearchesRemaining?: number;
  observations: import("../app/hunter-seeker-map-data").HunterSeekerObservation[];
};
type PublicWebcamRegionResult = {
  regionId: string;
  fetchedAt: string;
  totalAvailable: number;
  providerCandidates: number;
  returned: number;
  truncated: boolean;
  cacheState: "live" | "cached";
  provider: string;
  courtesyUrl: string;
  addCameraUrl: string;
  regionSearchesRemaining?: number;
  observations: import("../app/hunter-seeker-map-data").HunterSeekerObservation[];
};
