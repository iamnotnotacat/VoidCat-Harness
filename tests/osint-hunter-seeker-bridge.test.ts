import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { HunterSeekerPublicObservation } from "../build/hunter-seeker/hunter-seeker-service.ts";
import {
  HunterOsintCandidateInbox, OSINT_SCHEMA_VERSION, createHunterOsintInvestigationDraft, hunterRegionAroundPoint, submitOsintCandidateLeadToHunter,
  type HunterOsintSeedKind, type InvestigationSeed, type OsintLead,
} from "../build/osint/index.ts";

const AT = "2026-07-28T21:00:00.000Z";

function observation(id: string, entityId: string, entityType: string, sourceFeedId: string, attributes: Record<string, unknown>): HunterSeekerPublicObservation {
  return {
    observationId: id, entityId, entityType, position: { latitude: 29.75, longitude: -95.36, altitudeMeters: 1_000 }, timestamp: AT,
    provenance: { sourceFeedId, fetchedAt: AT, receivedAt: AT, upstreamTimestamp: AT, stalenessMs: 0 }, confidence: 0.9, basis: "measured", retentionClass: "bulk", attributes,
  };
}

const observationCases: Array<{ kind: HunterOsintSeedKind; expectedType: InvestigationSeed["type"]; value: HunterSeekerPublicObservation }> = [
  { kind: "aircraft", expectedType: "aircraft", value: observation("air-obs", "aircraft:ABC123", "civilian-aircraft", "opensky.civil-airspace", { callsign: "VOID1", transponderHex: "abc123", registration: "N100VC" }) },
  { kind: "vessel", expectedType: "vessel", value: observation("vessel-obs", "vessel:123456789", "maritime-vessel", "aisstream.maritime", { mmsi: "123456789", shipName: "VOID MARINER" }) },
  { kind: "satellite", expectedType: "satellite", value: observation("satellite-obs", "space-station:25544", "space-station", "celestrak.space-stations", { noradCatalogId: "25544", internationalDesignator: "1998-067A", title: "ISS" }) },
  { kind: "seismic", expectedType: "event", value: observation("seismic-obs", "earthquake:fixture", "earthquake", "usgs.earthquakes", { event: "M4.0 fixture", magnitude: 4 }) },
  { kind: "weather", expectedType: "event", value: observation("weather-obs", "weather-alert:fixture", "weather-alert", "noaa.nws-alerts", { event: "Flood Warning", severity: "Severe" }) },
];

test("aircraft, vessel, satellite, seismic, and weather observations become deliberate OSINT drafts with exact Hunter provenance", () => {
  for (const fixture of observationCases) {
    const draft = createHunterOsintInvestigationDraft({ observation: fixture.value }, { requestedAt: AT, requestedBy: { kind: "operator", id: "map-context-menu" } });
    assert.equal(draft.seedKind, fixture.kind); assert.equal(draft.seed.type, fixture.expectedType); assert.equal(draft.status, "draft-awaiting-provider-selection");
    assert.equal(draft.originalHunterObservation?.observationId, fixture.value.observationId); assert.equal(draft.originalHunterObservation?.entityId, fixture.value.entityId); assert.deepEqual(draft.originalHunterObservation?.provenance, fixture.value.provenance);
    assert.equal(draft.seed.source.kind, "hunter-seeker"); assert.equal(draft.seed.source.observationId, fixture.value.observationId); assert.equal(draft.intake?.evidence.metadata.hunterObservationId, fixture.value.observationId); assert.equal(draft.intake?.evidence.sourceRef, `hunter-seeker:${fixture.value.provenance.sourceFeedId}:${fixture.value.observationId}`);
    assert.deepEqual(draft.execution, { automatic: false, providerRequestsCreated: false, watchlistsCreated: false, triggerRulesCreated: false });
  }
});

test("a map point becomes a bounded geographic seed without inventing an observation", () => {
  const region = hunterRegionAroundPoint(29.75, -95.36, 25); const draft = createHunterOsintInvestigationDraft({ region }, { requestedAt: AT, requestedBy: { kind: "operator", id: "map-region-context" } });
  assert.equal(draft.seedKind, "geographic"); assert.equal(draft.seed.type, "geographic-area"); assert.equal(draft.seed.source.id, "hunter-seeker-map-region"); assert.equal(draft.originalHunterObservation, undefined); assert.equal(draft.intake, undefined); assert.deepEqual(draft.region, region);
  assert.equal(draft.seed.attributes.geometryType, "bbox"); assert.throws(() => hunterRegionAroundPoint(91, 0), /invalid/);
});

function candidateLead(overrides: Partial<OsintLead> = {}): OsintLead {
  return {
    schemaVersion: OSINT_SCHEMA_VERSION, id: "lead_gate7", investigationId: "inv_gate7", entityId: "ent_gate7", seed: { type: "aircraft", value: "ABC123", label: "Candidate aircraft", attributes: {}, source: { kind: "candidate-lead", id: "provider-fixture" } },
    reason: "Passive evidence produced a candidate identifier.", status: "candidate", depth: 1, discoveredByEvidenceIds: ["ev_gate7"], createdAt: AT, updatedAt: AT, ...overrides,
  };
}

test("OSINT leads enter Hunter as candidates without creating watchlists, triggers, history protection, or provider requests", () => {
  const submitted = submitOsintCandidateLeadToHunter({ investigationId: "inv_gate7", providerId: "fixture.passive", lead: candidateLead(), submittedAt: AT, submittedBy: { kind: "operator", id: "osint-result-action" } });
  assert.equal(submitted.status, "candidate"); assert.equal(submitted.lead.status, "candidate"); assert.equal(submitted.hunterActions.automatic, false); assert.equal(submitted.hunterActions.watchlistCreated, false); assert.equal(submitted.hunterActions.triggerRuleCreated, false); assert.equal(submitted.hunterActions.providerRequestCreated, false); assert.equal(submitted.hunterActions.protectedHistoryCreated, false);
  assert.deepEqual(submitted.allowedNextActions, ["review", "dismiss", "explicit-watchlist-request", "explicit-osint-approval"]);
  assert.throws(() => submitOsintCandidateLeadToHunter({ investigationId: "inv_gate7", providerId: "fixture.passive", lead: candidateLead({ status: "approved" }), submittedAt: AT, submittedBy: { kind: "operator", id: "osint-result-action" } }), /Only a depth-one candidate/);
});

test("the volatile Hunter candidate inbox is bounded, deduplicated, and dismissible", () => {
  const inbox = new HunterOsintCandidateInbox(2); const first = submitOsintCandidateLeadToHunter({ investigationId: "inv_gate7", providerId: "fixture.passive", lead: candidateLead(), submittedAt: AT, submittedBy: { kind: "operator", id: "operator" } });
  inbox.submit(first); inbox.submit(first); assert.equal(inbox.list().length, 1);
  const second = submitOsintCandidateLeadToHunter({ investigationId: "inv_gate7", providerId: "fixture.passive", lead: candidateLead({ id: "lead_gate7_b", seed: { ...candidateLead().seed, value: "DEF456" } }), submittedAt: "2026-07-28T21:01:00.000Z", submittedBy: { kind: "hunter-seeker", id: "hunter-review" } });
  const third = submitOsintCandidateLeadToHunter({ investigationId: "inv_gate7", providerId: "fixture.passive", lead: candidateLead({ id: "lead_gate7_c", seed: { ...candidateLead().seed, value: "GHI789" } }), submittedAt: "2026-07-28T21:02:00.000Z", submittedBy: { kind: "operator", id: "operator" } });
  inbox.submit(second); inbox.submit(third); assert.deepEqual(inbox.list().map(({ id }) => id), [third.id, second.id]); assert.equal(inbox.dismiss(second.id), true); assert.deepEqual(inbox.list().map(({ id }) => id), [third.id]);
});

test("the Gate 7 contract has no provider execution, watchlist, trigger, or persistence dependency", async () => {
  const source = await readFile(path.join(process.cwd(), "build", "osint", "hunter-seeker-bridge.ts"), "utf8");
  for (const forbidden of [/\bfetch\s*\(/, /\.query\s*\(/, /\.start\s*\(/, /HunterStageFiveStore/, /HunterHistoryStore/, /DatabaseSync/, /writeFile/, /safeStorage/, /credentialStore/]) assert.doesNotMatch(source, forbidden);
});
