const assert = require("node:assert/strict");
const test = require("node:test");
const { AISSTREAM_URL, AisstreamMaritimeService } = require("../desktop/aisstream-maritime-service.cjs");

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  send(value) { this.sent.push(value); }
  close() { this.emit("close", {}); }
  emit(name, event) { this.listeners.get(name)?.(event); }
}

test("maritime service authenticates in the main process and emits normalized volatile vessel positions", async () => {
  FakeWebSocket.instances = [];
  let now = Date.parse("2026-07-27T18:00:00.000Z");
  const service = new AisstreamMaritimeService({
    getCredential: () => "protected-api-key",
    WebSocketImplementation: FakeWebSocket,
    now: () => now,
  });
  const starting = await service.start(["north-america-east"]);
  assert.equal(starting.status, "connecting");
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, AISSTREAM_URL);
  socket.emit("open", {});
  const subscription = JSON.parse(socket.sent[0]);
  assert.equal(subscription.APIKey, "protected-api-key");
  assert.deepEqual(subscription.BoundingBoxes, [[[24, -82], [52, -52]]]);
  assert.deepEqual(starting.regionIds, ["north-america-east"]);
  assert.equal(starting.displayCadenceMs, 2 * 60_000);

  await service.handleMessage(JSON.stringify({
    MessageType: "PositionReport",
    Metadata: { MMSI: 367123456, ShipName: "VOID MARINER", latitude: 28.1, longitude: -90.2, time_utc: "2026-07-27 18:00:00 +0000 UTC" },
    Message: { PositionReport: { UserID: 367123456, Latitude: 28.1, Longitude: -90.2, Sog: 12.4, Cog: 84.2, TrueHeading: 85, PositionAccuracy: true, Valid: true } },
  }), socket);
  const snapshot = service.snapshot();
  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].entityId, "vessel:367123456");
  assert.equal(snapshot.observations[0].attributes.speedOverGroundKnots, 12.4);
  assert.equal(JSON.stringify(snapshot).includes("protected-api-key"), false);

  service.setDisplayCadence(12 * 60 * 60_000);
  const disabled = service.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.observations.length, 1);

  now += 60 * 60_000;
  assert.equal(service.snapshot().observations.length, 1);

  const restored = await service.start(["north-america-east"]);
  assert.equal(restored.enabled, true);
  assert.equal(restored.observations.length, 1);

  const stopped = service.stop();
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.observations.length, 0);
});

test("maritime service refuses unsupported regions and missing credentials", async () => {
  const missing = new AisstreamMaritimeService({ getCredential: () => null, WebSocketImplementation: FakeWebSocket });
  await assert.rejects(() => missing.start(["gulf-of-mexico"]), /API key is required/i);
  const valid = new AisstreamMaritimeService({ getCredential: () => "token", WebSocketImplementation: FakeWebSocket });
  await assert.rejects(() => valid.start(["global"]), /unsupported maritime coverage/i);
  await assert.rejects(() => valid.start(["gulf-of-mexico", "north-atlantic"]), /exactly one/i);
  assert.throws(() => valid.setDisplayCadence(29_999), /between 30 seconds and 12 hours/i);
  assert.equal(valid.setDisplayCadence(30_000).displayCadenceMs, 30_000);
});

test("maritime credentials are accepted only after an authenticated provider message", async () => {
  FakeWebSocket.instances = [];
  const service = new AisstreamMaritimeService({ getCredential: () => "saved", WebSocketImplementation: FakeWebSocket });
  const accepted = service.testCredential("candidate", ["gulf-of-mexico"], 2_000);
  const validSocket = FakeWebSocket.instances[0];
  validSocket.emit("open", {});
  assert.equal(JSON.parse(validSocket.sent[0]).APIKey, "candidate");
  validSocket.emit("message", { data: JSON.stringify({ MessageType: "PositionReport" }) });
  assert.equal((await accepted).verifiedBy, "authenticated-provider-message");

  const rejected = service.testCredential("wrong", ["gulf-of-mexico"], 2_000);
  const invalidSocket = FakeWebSocket.instances[1];
  invalidSocket.emit("open", {});
  invalidSocket.emit("message", { data: JSON.stringify({ error: "invalid key" }) });
  await assert.rejects(rejected, /rejected this API key/i);
});

test("maritime health reports hourly throughput and automatically degrades on silent zero", async () => {
  FakeWebSocket.instances = [];
  let now = Date.parse("2026-07-28T12:00:00.000Z");
  const service = new AisstreamMaritimeService({ getCredential: () => "protected", WebSocketImplementation: FakeWebSocket, now: () => now });
  await service.start(["gulf-of-mexico"]); const socket = FakeWebSocket.instances[0]; socket.emit("open", {});
  const message = JSON.stringify({ MessageType: "PositionReport", Metadata: { MMSI: 367123456, latitude: 28.1, longitude: -90.2 }, Message: { PositionReport: { UserID: 367123456, Latitude: 28.1, Longitude: -90.2 } } });
  await service.handleMessage(message, socket);
  let health = service.snapshot();
  assert.equal(health.recordsPerHour, 1); assert.equal(health.expectedBaseline, 1); assert.equal(health.errorRate, 0); assert.equal(health.silentZero, false); assert.equal(health.aiContextEligible, true);
  now += 5 * 60_000 + 1;
  health = service.snapshot();
  assert.equal(health.status, "degraded"); assert.equal(health.silentZero, true); assert.equal(health.aiContextEligible, false);
  await service.handleMessage(message, socket); await service.handleMessage("not json", socket);
  health = service.snapshot();
  assert.equal(health.status, "healthy"); assert.equal(health.recordsPerHour, 2); assert.ok(health.errorRate > 0); assert.equal(health.silentZero, false); assert.equal(health.aiContextEligible, true);
  service.stop();
});
