/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_WEBCAM_SOURCE_ID, PublicWebcamAdapter, publicWebcamRegions } from "../build/hunter-seeker/adapters/public-webcam-adapter.ts";
import { WINDY_WEBCAM_SOURCE_ID, WindyWebcamAdapter } from "../build/hunter-seeker/adapters/windy-webcam-adapter.ts";
import { validateNormalizedObservation, validateSourceDescriptor } from "../build/hunter-seeker/source-adapter.ts";

test("public webcams publish a lightweight fixed worldwide sector index without network access", async () => {
  const adapter = new PublicWebcamAdapter();
  assert.doesNotThrow(() => validateSourceDescriptor(adapter.descriptor));
  assert.equal(adapter.descriptor.credentialType, "api-key");
  const regions = publicWebcamRegions();
  assert.equal(regions.length, 162);
  assert.equal(new Set(regions.map((region) => region.id)).size, regions.length);
  const payload = await adapter.fetch();
  const observations = adapter.normalize(payload, { fetchedAt: "2026-07-30T12:00:00Z", receivedAt: "2026-07-30T12:00:01Z" });
  assert.equal(observations.length, 162);
  assert.ok(observations.every((observation) => observation.entityType === "imagery.public-webcam-region"));
  observations.forEach((observation) => assert.doesNotThrow(() => validateNormalizedObservation(observation, PUBLIC_WEBCAM_SOURCE_ID)));
});

test("Windy and YouTube publish separate selectable regional layers", async () => {
  const youtube = new PublicWebcamAdapter();
  const windy = new WindyWebcamAdapter();
  const context = { fetchedAt: "2026-07-30T12:00:00Z", receivedAt: "2026-07-30T12:00:01Z" };
  const youtubeObservations = youtube.normalize(await youtube.fetch(), context);
  const windyObservations = windy.normalize(await windy.fetch(), context);
  assert.equal(youtubeObservations.length, 162);
  assert.equal(windyObservations.length, 162);
  assert.notEqual(PUBLIC_WEBCAM_SOURCE_ID, WINDY_WEBCAM_SOURCE_ID);
  assert.ok(youtubeObservations.every((observation) => observation.provenance.sourceFeedId === PUBLIC_WEBCAM_SOURCE_ID));
  assert.ok(windyObservations.every((observation) => observation.provenance.sourceFeedId === WINDY_WEBCAM_SOURCE_ID));
  assert.notDeepEqual(youtubeObservations[0].position, windyObservations[0].position, "provider hubs are offset so both remain clickable when enabled together");
});
