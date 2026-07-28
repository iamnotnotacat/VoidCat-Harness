const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const AISSTREAM_SOURCE_ID = "aisstream.maritime";
const MAX_VESSELS = 2_000;
const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_MESSAGES_PER_MINUTE = 1_200;
const VESSEL_TTL_MS = 30 * 60_000;
const MIN_DISPLAY_CADENCE_MS = 30_000;
const MAX_DISPLAY_CADENCE_MS = 12 * 60 * 60_000;
const DEFAULT_DISPLAY_CADENCE_MS = 2 * 60_000;

const REGIONS = Object.freeze({
  "gulf-of-mexico": { label: "Gulf of Mexico", boundingBoxes: [[[18, -98], [31, -80]]] },
  "north-america-east": { label: "North America — East Coast", boundingBoxes: [[[24, -82], [52, -52]]] },
  "north-america-west": { label: "North America — West Coast", boundingBoxes: [[[23, -135], [61, -105]]] },
  "north-atlantic": { label: "North Atlantic", boundingBoxes: [[[35, -75], [66, 10]]] },
  mediterranean: { label: "Mediterranean", boundingBoxes: [[[29, -7], [47, 38]]] },
  baltic: { label: "Baltic Sea", boundingBoxes: [[[53, 9], [66, 31]]] },
  "southeast-asia": { label: "Southeast Asia", boundingBoxes: [[[-11, 94], [24, 142]]] },
});

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim().replaceAll("@", "") : undefined;
}

function parseTimestamp(value, fallback) {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value.replace(/ \+0000 UTC$/i, "Z").replace(/ UTC$/i, "Z"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function websocketImplementation() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  return require("undici").WebSocket;
}

function validateRegionIds(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error("Select exactly one maritime coverage region.");
  if (unique.some((regionId) => !REGIONS[regionId])) throw new Error("Unsupported maritime coverage region.");
  return unique;
}

function validateDisplayCadence(value) {
  const cadence = Number(value);
  if (!Number.isFinite(cadence) || cadence < MIN_DISPLAY_CADENCE_MS || cadence > MAX_DISPLAY_CADENCE_MS) {
    throw new Error("Maritime map update rate must be between 30 seconds and 12 hours.");
  }
  return Math.round(cadence);
}

class AisstreamMaritimeService {
  constructor(options) {
    if (typeof options?.getCredential !== "function") throw new Error("The maritime service requires a secure credential provider.");
    this.getCredential = options.getCredential;
    this.WebSocketImplementation = options.WebSocketImplementation ?? websocketImplementation();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.socket = null;
    this.reconnectTimer = null;
    this.requested = false;
    this.regionIds = validateRegionIds(options.defaultRegionIds ?? ["gulf-of-mexico"]);
    this.displayCadenceMs = validateDisplayCadence(options.defaultDisplayCadenceMs ?? DEFAULT_DISPLAY_CADENCE_MS);
    this.status = "disabled";
    this.message = "Credentialed maritime stream is off.";
    this.connectedAt = null;
    this.lastMessageAt = null;
    this.messageTimes = [];
    this.droppedMessages = 0;
    this.reconnectAttempt = 0;
    this.observations = new Map();
    this.cacheRetainUntil = 0;
  }

  async start(regionIds = this.regionIds) {
    const selectedRegionIds = validateRegionIds(regionIds);
    const credential = this.getCredential();
    if (!credential) throw new Error("An aisstream.io API key is required before enabling this source.");
    const sameRegion = selectedRegionIds.length === this.regionIds.length && selectedRegionIds.every((regionId, index) => regionId === this.regionIds[index]);
    this.stopSocket();
    this.requested = true;
    this.regionIds = selectedRegionIds;
    if (!sameRegion) {
      this.observations.clear();
      this.cacheRetainUntil = 0;
    }
    this.messageTimes = [];
    this.droppedMessages = 0;
    this.status = "connecting";
    this.message = `Connecting to ${this.regionLabel()}.`;
    this.connect(credential);
    return this.snapshot();
  }

  connect(credential) {
    if (!this.requested) return;
    const socket = new this.WebSocketImplementation(AISSTREAM_URL);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || !this.requested) return;
      this.sendSubscription(socket, credential);
      credential = "";
      this.connectedAt = new Date(this.now()).toISOString();
      this.status = "healthy";
      this.message = `Live AIS stream connected for ${this.regionLabel()}.`;
      this.reconnectAttempt = 0;
    });
    socket.addEventListener("message", (event) => { void this.handleMessage(event.data, socket); });
    socket.addEventListener("error", () => {
      if (this.socket !== socket || !this.requested) return;
      this.status = "degraded";
      this.message = "The maritime stream reported a connection error.";
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.requested) this.scheduleReconnect();
    });
  }

  async handleMessage(raw, socket) {
    if (this.socket !== socket || !this.requested) return;
    let serialized;
    if (typeof raw === "string") serialized = raw;
    else if (Buffer.isBuffer(raw)) serialized = raw.toString("utf8");
    else if (raw && typeof raw.text === "function") serialized = await raw.text();
    else return;
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
      this.droppedMessages += 1;
      return;
    }
    const currentTime = this.now();
    this.messageTimes = this.messageTimes.filter((time) => time > currentTime - 60_000);
    if (this.messageTimes.length >= MAX_MESSAGES_PER_MINUTE) {
      this.requested = false;
      this.status = "degraded";
      this.message = "Maritime stream stopped at the 1,200-message-per-minute local safety cap. Choose a smaller coverage region before reconnecting.";
      this.stopSocket();
      return;
    }
    this.messageTimes.push(currentTime);
    let payload;
    try { payload = JSON.parse(serialized); } catch { this.droppedMessages += 1; return; }
    if (payload?.error) {
      this.requested = false;
      this.status = "down";
      this.message = "aisstream.io rejected the subscription. Verify or replace the saved API key before reconnecting.";
      this.stopSocket();
      return;
    }
    const observation = this.normalize(payload, currentTime);
    if (!observation) { this.droppedMessages += 1; return; }
    this.observations.set(observation.entityId, observation);
    if (this.observations.size > MAX_VESSELS) {
      const oldest = [...this.observations.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
      oldest.slice(0, this.observations.size - MAX_VESSELS).forEach((item) => this.observations.delete(item.entityId));
    }
    this.lastMessageAt = new Date(currentTime).toISOString();
    this.status = "healthy";
    this.message = `Live vessel positions held in volatile memory for ${this.regionLabel()}.`;
  }

  normalize(payload, currentTime) {
    if (!payload || typeof payload !== "object") return null;
    const messageType = text(payload.MessageType);
    const body = messageType && payload.Message && typeof payload.Message === "object" ? payload.Message[messageType] : null;
    const metadata = payload.Metadata ?? payload.MetaData;
    if (!messageType || !body || typeof body !== "object" || !metadata || typeof metadata !== "object") return null;
    const latitude = number(body.Latitude) ?? number(metadata.Latitude) ?? number(metadata.latitude);
    const longitude = number(body.Longitude) ?? number(metadata.Longitude) ?? number(metadata.longitude);
    const mmsiValue = number(body.UserID) ?? number(metadata.MMSI);
    if (latitude === undefined || longitude === undefined || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || mmsiValue === undefined) return null;
    const mmsi = String(Math.trunc(mmsiValue));
    if (!/^\d{6,9}$/.test(mmsi)) return null;
    const receivedAt = new Date(currentTime).toISOString();
    const timestamp = parseTimestamp(metadata.time_utc ?? metadata.TimeUtc, receivedAt);
    const stalenessMs = Math.max(0, currentTime - Date.parse(timestamp));
    const shipName = text(metadata.ShipName) ?? text(metadata.shipName) ?? text(body.Name);
    const heading = number(body.TrueHeading);
    const course = number(body.Cog);
    return {
      observationId: `aisstream-vessel:${mmsi}`,
      entityId: `vessel:${mmsi}`,
      entityType: "maritime-vessel",
      position: { latitude, longitude },
      timestamp,
      provenance: {
        sourceFeedId: AISSTREAM_SOURCE_ID,
        fetchedAt: receivedAt,
        receivedAt,
        upstreamTimestamp: timestamp,
        stalenessMs,
      },
      confidence: body.PositionAccuracy === true ? 0.9 : 0.75,
      basis: "measured",
      retentionClass: "bulk",
      attributes: {
        title: shipName ?? `MMSI ${mmsi}`,
        shipName: shipName ?? null,
        mmsi,
        messageType,
        speedOverGroundKnots: number(body.Sog) ?? null,
        courseOverGroundDegrees: course ?? null,
        trueHeadingDegrees: heading !== undefined && heading <= 359 ? heading : null,
        trackDegrees: heading !== undefined && heading <= 359 ? heading : course ?? 0,
        navigationalStatusCode: number(body.NavigationalStatus) ?? null,
        positionAccuracy: body.PositionAccuracy === true,
        coverageRegion: this.regionLabel(),
        eventUrl: "https://aisstream.io/coverage",
      },
    };
  }

  scheduleReconnect() {
    if (!this.requested || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const waitMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(6, this.reconnectAttempt - 1));
    this.status = "degraded";
    this.message = `Maritime link interrupted; retrying in ${Math.ceil(waitMs / 1_000)} seconds.`;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.requested) return;
      const credential = this.getCredential();
      if (!credential) {
        this.requested = false;
        this.status = "down";
        this.message = "Saved maritime credential is no longer available.";
        return;
      }
      this.connect(credential);
    }, waitMs);
  }

  activeRegionIds() {
    return [...this.regionIds];
  }

  sendSubscription(socket, credential = this.getCredential()) {
    if (!credential) throw new Error("Saved maritime credential is no longer available.");
    const activeRegions = this.activeRegionIds();
    socket.send(JSON.stringify({
      APIKey: credential,
      BoundingBoxes: activeRegions.flatMap((regionId) => REGIONS[regionId].boundingBoxes),
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "LongRangeAisBroadcastMessage"],
    }));
    this.message = `Live AIS stream scanning ${activeRegions.map((regionId) => REGIONS[regionId].label).join(" + ")}.`;
  }

  stopSocket() {
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* The socket is already closed. */ }
  }

  regionLabel() {
    return REGIONS[this.regionIds[0]].label;
  }

  setDisplayCadence(displayCadenceMs) {
    this.displayCadenceMs = validateDisplayCadence(displayCadenceMs);
    if (!this.requested) this.cacheRetainUntil = Math.max(this.cacheRetainUntil, this.now() + this.displayCadenceMs);
    return { displayCadenceMs: this.displayCadenceMs };
  }

  disable() {
    this.requested = false;
    this.stopSocket();
    this.cacheRetainUntil = Math.max(this.cacheRetainUntil, this.now() + this.displayCadenceMs);
    this.connectedAt = null;
    this.status = "disabled";
    this.message = this.observations.size
      ? `Maritime stream is off; ${this.observations.size.toLocaleString()} recent positions remain in volatile cache.`
      : "Credentialed maritime stream is off.";
    return this.snapshot();
  }

  stop() {
    this.requested = false;
    this.stopSocket();
    this.observations.clear();
    this.cacheRetainUntil = 0;
    this.messageTimes = [];
    this.connectedAt = null;
    this.lastMessageAt = null;
    this.droppedMessages = 0;
    this.status = "disabled";
    this.message = "Credentialed maritime stream is off.";
    return this.snapshot();
  }

  snapshot() {
    const currentTime = this.now();
    for (const [id, observation] of this.observations) {
      if (currentTime >= this.cacheRetainUntil && Date.parse(observation.timestamp) < currentTime - VESSEL_TTL_MS) this.observations.delete(id);
    }
    return {
      sourceId: AISSTREAM_SOURCE_ID,
      enabled: this.requested,
      status: this.status,
      message: this.message,
      regionIds: [...this.regionIds],
      activeRegionIds: this.activeRegionIds(),
      regionLabel: this.regionLabel(),
      displayCadenceMs: this.displayCadenceMs,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      droppedMessages: this.droppedMessages,
      observations: [...this.observations.values()].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)),
    };
  }
}

module.exports = { AISSTREAM_SOURCE_ID, AISSTREAM_URL, REGIONS, AisstreamMaritimeService };
