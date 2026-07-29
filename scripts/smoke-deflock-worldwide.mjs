/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { DeflockAlprAdapter } from "../build/hunter-seeker/adapters/deflock-alpr-adapter.ts";

const adapter = new DeflockAlprAdapter();
const requestedAt = new Date().toISOString();
const indexPayload = await adapter.fetch({ signal: AbortSignal.timeout(60_000), requestedAt });
if (indexPayload.voidcat?.coverage !== "worldwide") throw new Error("DeFlock did not report worldwide index coverage.");
const markers = indexPayload.voidcat.regionMarkers ?? [];
if (markers.length < 2) throw new Error("DeFlock did not load its advertised region index.");
adapter.selectRegion(markers[0].id);
const regionPayload = await adapter.fetch({ signal: AbortSignal.timeout(60_000), requestedAt });
const observations = adapter.normalize(regionPayload, { fetchedAt: requestedAt, receivedAt: new Date().toISOString() });
const cameras = observations.filter(({ entityType }) => entityType.includes("alpr-camera"));
if (!cameras.length) throw new Error("The selected DeFlock region returned no normalized cameras.");
if (new Set(observations.map(({ observationId }) => observationId)).size !== observations.length) throw new Error("DeFlock region observations contained duplicate IDs.");
console.log(JSON.stringify({ coverage: indexPayload.voidcat.coverage, regionHubs: markers.length, selectedRegion: markers[0].id, cameras: cameras.length, bytes: regionPayload.voidcat?.fetchedBytes, health: adapter.health() }, null, 2));
