export const SOURCE_CATEGORIES = [
  "aviation",
  "maritime",
  "space",
  "seismic",
  "weather",
  "environment",
  "radio",
  "transit",
  "infrastructure",
  "threat-intelligence",
  "imagery",
] as const;

export type SourceCategory = typeof SOURCE_CATEGORIES[number];
export type SourceAuthTier = "tier-1" | "tier-2" | "tier-3";
export type CredentialType = "none" | "api-key" | "oauth2-client-credentials" | "websocket-token";
export type ObservationBasis = "measured" | "derived" | "estimated";
export type RetentionClass = "bulk" | "protected" | "derived";

export type SourceDescriptor = {
  id: string;
  displayName: string;
  category: SourceCategory;
  authTier: SourceAuthTier;
  credentialType: CredentialType;
  pollCadenceMs: number;
  rateLimit: {
    requestsPerWindow: number;
    windowMs: number;
    hardHourlyBudget: number;
  };
  providerDocsUrl: string;
  signupUrl?: string;
  cache: {
    ttlMs: number;
    maxObservations: number;
  };
  healthPolicy?: {
    expectedMinimumObservations: number;
    consecutiveBelowExpectedLimit: number;
  };
  retentionPolicy: {
    mode: "live-only";
  } | {
    mode: "persistent";
    maxAgeMs: number;
  };
  estimatedBytesPerDay: number;
};

export type ObservationPosition = {
  latitude: number;
  longitude: number;
  altitudeMeters?: number;
  accuracyMeters?: number;
};

export type ObservationProvenance = {
  sourceFeedId: string;
  fetchedAt: string;
  receivedAt: string;
  upstreamTimestamp?: string;
  stalenessMs: number;
};

export type NormalizedObservation = {
  observationId: string;
  entityId: string;
  entityType: string;
  position: ObservationPosition;
  timestamp: string;
  provenance: ObservationProvenance;
  confidence: number;
  basis: ObservationBasis;
  retentionClass: RetentionClass;
  attributes: Record<string, unknown>;
  rawPayload?: unknown;
};

export type AdapterFetchContext = {
  signal: AbortSignal;
  requestedAt: string;
};

export type AdapterNormalizeContext = {
  fetchedAt: string;
  receivedAt: string;
};

export type SourceCreditBudget = {
  remainingCredits?: number;
  requestCostCredits: number;
  reserveCredits: number;
  effectiveRefreshMs: number;
  estimatedRefillAt: string;
  nextNetworkAt: string;
  basis: "rolling-24-hour-estimate" | "provider-retry-after" | "safe-fallback";
};

export type AdapterReportedHealth = {
  status: "healthy" | "degraded" | "down";
  message?: string;
  creditBudget?: SourceCreditBudget;
};

export interface SourceAdapter<RawPayload = unknown> {
  readonly descriptor: SourceDescriptor;
  fetch(context: AdapterFetchContext): Promise<RawPayload>;
  normalize(payload: RawPayload, context: AdapterNormalizeContext): Promise<NormalizedObservation[]> | NormalizedObservation[];
  health(): Promise<AdapterReportedHealth> | AdapterReportedHealth;
}

export class SourceAdapterHttpError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;

  constructor(message: string, statusCode: number, retryAfterMs?: number) {
    super(message);
    this.name = "SourceAdapterHttpError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ObservationValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Observation failed validation: ${issues.join("; ")}`);
    this.name = "ObservationValidationError";
    this.issues = issues;
  }
}

function isWebUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: string) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function validateSourceDescriptor(descriptor: SourceDescriptor) {
  const issues: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(descriptor.id)) issues.push("id must be a stable lowercase registry key");
  if (!descriptor.displayName.trim()) issues.push("displayName is required");
  if (!SOURCE_CATEGORIES.includes(descriptor.category)) issues.push("category is not supported");
  if (descriptor.pollCadenceMs < 1_000) issues.push("pollCadenceMs must be at least 1000");
  if (descriptor.rateLimit.requestsPerWindow < 1) issues.push("requestsPerWindow must be positive");
  if (descriptor.rateLimit.windowMs < 1_000) issues.push("rate-limit window must be at least 1000 ms");
  if (descriptor.rateLimit.hardHourlyBudget < 1) issues.push("hardHourlyBudget must be positive");
  if (!isWebUrl(descriptor.providerDocsUrl)) issues.push("providerDocsUrl must be an HTTP(S) URL");
  if (descriptor.signupUrl && !isWebUrl(descriptor.signupUrl)) issues.push("signupUrl must be an HTTP(S) URL");
  if (descriptor.cache.ttlMs < 1_000) issues.push("cache TTL must be at least 1000 ms");
  if (descriptor.cache.maxObservations < 1) issues.push("cache maxObservations must be positive");
  if (descriptor.healthPolicy && (!Number.isInteger(descriptor.healthPolicy.expectedMinimumObservations) || descriptor.healthPolicy.expectedMinimumObservations < 0)) issues.push("health expectedMinimumObservations must be a non-negative integer");
  if (descriptor.healthPolicy && (!Number.isInteger(descriptor.healthPolicy.consecutiveBelowExpectedLimit) || descriptor.healthPolicy.consecutiveBelowExpectedLimit < 1)) issues.push("health consecutiveBelowExpectedLimit must be a positive integer");
  if (descriptor.retentionPolicy.mode === "persistent" && descriptor.retentionPolicy.maxAgeMs < 1_000) issues.push("persistent retention must be at least 1000 ms");
  if (!Number.isFinite(descriptor.estimatedBytesPerDay) || descriptor.estimatedBytesPerDay < 0) issues.push("estimatedBytesPerDay cannot be negative");
  if (descriptor.authTier === "tier-1" && descriptor.credentialType !== "none") issues.push("tier-1 sources cannot require credentials");
  if (issues.length) throw new Error(`Invalid source descriptor ${descriptor.id || "<unknown>"}: ${issues.join("; ")}`);
}

export function validateNormalizedObservation(observation: NormalizedObservation, expectedSourceId: string) {
  const issues: string[] = [];
  if (!observation.observationId?.trim()) issues.push("observationId is required");
  if (!observation.entityId?.trim()) issues.push("entityId is required");
  if (!observation.entityType?.trim()) issues.push("entityType is required");
  if (!Number.isFinite(observation.position?.latitude) || observation.position.latitude < -90 || observation.position.latitude > 90) issues.push("latitude must be between -90 and 90");
  if (!Number.isFinite(observation.position?.longitude) || observation.position.longitude < -180 || observation.position.longitude > 180) issues.push("longitude must be between -180 and 180");
  if (observation.position.altitudeMeters !== undefined && !Number.isFinite(observation.position.altitudeMeters)) issues.push("altitudeMeters must be finite");
  if (observation.position.accuracyMeters !== undefined && (!Number.isFinite(observation.position.accuracyMeters) || observation.position.accuracyMeters < 0)) issues.push("accuracyMeters cannot be negative");
  if (!isIsoTimestamp(observation.timestamp)) issues.push("timestamp must be a valid timestamp");
  if (observation.provenance?.sourceFeedId !== expectedSourceId) issues.push("provenance source does not match its adapter");
  if (!isIsoTimestamp(observation.provenance?.fetchedAt)) issues.push("fetchedAt must be a valid timestamp");
  if (!isIsoTimestamp(observation.provenance?.receivedAt)) issues.push("receivedAt must be a valid timestamp");
  if (observation.provenance?.upstreamTimestamp && !isIsoTimestamp(observation.provenance.upstreamTimestamp)) issues.push("upstreamTimestamp must be a valid timestamp");
  if (!Number.isFinite(observation.provenance?.stalenessMs) || observation.provenance.stalenessMs < 0) issues.push("stalenessMs cannot be negative");
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) issues.push("confidence must be between 0 and 1");
  if (!(["measured", "derived", "estimated"] as const).includes(observation.basis)) issues.push("basis is invalid");
  if (!(["bulk", "protected", "derived"] as const).includes(observation.retentionClass)) issues.push("retentionClass is invalid");
  if (!observation.attributes || Array.isArray(observation.attributes) || typeof observation.attributes !== "object") issues.push("attributes must be an object");
  if (issues.length) throw new ObservationValidationError(issues);
}
