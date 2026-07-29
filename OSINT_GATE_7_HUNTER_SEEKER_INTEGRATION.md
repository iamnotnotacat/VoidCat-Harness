# OSINT Gate 7 — Hunter-Seeker integration

Status: implemented and verified. The integration provides two operator-controlled handoffs and does not create an autonomous bridge between Hunter-Seeker and OSINT.

## Hunter-Seeker to OSINT

Right-clicking an aircraft, vessel, satellite, seismic event, weather event, other map object, or empty map region exposes **Investigate in OSINT**. The click creates a draft and opens the OSINT provider screen. It does not contact a provider.

Observation drafts retain the exact Hunter-Seeker observation ID, entity ID, entity type, timestamp, and complete provenance object. The normalized intake evidence also records the Hunter observation ID and a source reference containing the original feed and observation IDs. Geographic clicks create a bounded 25 km region seed and do not invent an observation ID.

The OSINT screen visibly marks the handoff as **awaiting provider selection** and states that no provider request, watchlist, or trigger was created. The operator must choose or review a compatible passive provider and explicitly run the lookup. SearXNG can accept deliberately submitted Hunter identifiers, event seeds, and regions; DeFlock remains the direct passive provider for geographic ALPR-camera queries.

## OSINT to Hunter-Seeker

Normalized depth-one leads are displayed as candidates. **Submit candidate to Hunter** sends only the named lead from the exact current investigation into a bounded, volatile Hunter inbox. The backend re-resolves the lead from its own short-lived result cache instead of accepting an arbitrary lead object from the renderer.

Every returned item remains `candidate`. The handoff contract explicitly records that it did not:

- create a watchlist;
- create a trigger rule;
- start another provider request;
- protect historical records;
- perform an automatic action.

Hunter-Seeker shows these items in a review-only candidate inbox with a dismiss action. It does not silently promote them. Live candidate source records expire after 30 minutes and both the source cache and inbox are capped at 100 entries. They clear when the application exits.

HIBP exposure evidence is excluded from this path. The backend never places HIBP leads in the handoff cache, and the UI keeps Hunter forwarding blocked pending a separate approval flow.

## Verification

The complete application suite passes **192 tests**, lint, type checking through the build, and the production bundle.

`tests/osint-hunter-seeker-bridge.test.ts` proves:

- aircraft, vessel, satellite, seismic, weather, and geographic seeds;
- exact observation ID and provenance retention;
- candidate-only status and false side-effect flags;
- bounded deduplication and dismissal;
- the bridge contract contains no provider execution, database, credential, watchlist, trigger, or filesystem-write primitive.

`tests/osint-gate-seven-integration.test.ts` proves:

- both explicit UI actions and their local routes are wired;
- investigation intake cannot start a provider;
- candidate submission resolves one named backend-held lead;
- the submission path cannot create watchlists, triggers, provider requests, protected history, or implicit research;
- HIBP is excluded;
- all requested Hunter seed classes have a compatible deliberate passive-provider path.

## Operator smoke test

1. Open Hunter-Seeker and right-click one live contact. Select **Investigate in OSINT**.
2. Confirm the OSINT draft shows the same observation ID and source feed as Hunter-Seeker.
3. Confirm no lookup runs until **Run passive check** is clicked.
4. Run a configured SearXNG lookup, select a returned candidate lead, and click **Submit candidate to Hunter**.
5. Confirm Hunter-Seeker shows the item as **Candidate** with **No watchlist / No trigger / No provider request**.
6. Dismiss the candidate and confirm it leaves the inbox.
7. Repeat from an empty map region and confirm the OSINT draft says **Map region** instead of inventing an observation ID.

