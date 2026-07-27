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
  const now = Date.parse("2026-07-27T18:00:00.000Z");
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
