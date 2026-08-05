/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
export type CommandToolDefinition = {
  name: string;
  group: "HUNTER-SEEKER" | "OSINT INVESTIGATION" | "VOIDCAT KNOWLEDGE";
  label: string;
  description: string;
  access: "LOCAL" | "EXTERNAL";
};

export const COMMAND_TOOLS: CommandToolDefinition[] = [
  { name: "hunter-seeker.aircraft-in-bbox", group: "HUNTER-SEEKER", label: "Aircraft in area", description: "Read current aircraft positions inside a bounded map area.", access: "LOCAL" },
  { name: "hunter-seeker.aircraft-by-callsign-or-icao", group: "HUNTER-SEEKER", label: "Aircraft identity", description: "Find current aircraft by exact callsign or ICAO address.", access: "LOCAL" },
  { name: "hunter-seeker.vessels-in-bbox", group: "HUNTER-SEEKER", label: "Vessels in area", description: "Read current AIS vessel positions in the selected maritime coverage.", access: "LOCAL" },
  { name: "hunter-seeker.satellite-passes-over-area", group: "HUNTER-SEEKER", label: "Satellite passes", description: "Estimate bounded satellite passes from cached orbital elements.", access: "LOCAL" },
  { name: "hunter-seeker.recent-seismic", group: "HUNTER-SEEKER", label: "Recent seismic events", description: "Read recent earthquakes by age and magnitude.", access: "LOCAL" },
  { name: "hunter-seeker.feed-health-status", group: "HUNTER-SEEKER", label: "Feed health", description: "Inspect source freshness, failures, coverage, and next request times.", access: "LOCAL" },
  { name: "osint-unit.investigate-domain", group: "OSINT INVESTIGATION", label: "Investigate domain", description: "Run the fixed passive domain enrichment path.", access: "EXTERNAL" },
  { name: "osint-unit.investigate-ip", group: "OSINT INVESTIGATION", label: "Investigate IP", description: "Use configured passive infrastructure sources for one exact IP.", access: "EXTERNAL" },
  { name: "osint-unit.investigate-username", group: "OSINT INVESTIGATION", label: "Investigate username", description: "Search configured passive discovery for one exact username.", access: "EXTERNAL" },
  { name: "osint-unit.investigate-organization", group: "OSINT INVESTIGATION", label: "Investigate organization", description: "Search configured passive discovery for an organization.", access: "EXTERNAL" },
  { name: "osint-unit.investigate-infrastructure", group: "OSINT INVESTIGATION", label: "Investigate infrastructure", description: "Correlate configured passive infrastructure sources.", access: "EXTERNAL" },
  { name: "osint-unit.authorized-exposure-check", group: "OSINT INVESTIGATION", label: "Authorized exposure check", description: "Use a separately approved, exact-target exposure check once.", access: "EXTERNAL" },
  { name: "osint-unit.investigate-hunter-event", group: "OSINT INVESTIGATION", label: "Investigate Hunter event", description: "Enrich one exact Hunter observation while retaining provenance.", access: "EXTERNAL" },
  { name: "osint-unit.search-passive-web-sources", group: "OSINT INVESTIGATION", label: "Passive web discovery", description: "Run one bounded query through configured passive web sources.", access: "EXTERNAL" },
  { name: "osint-unit.expand-entity", group: "OSINT INVESTIGATION", label: "Evaluate candidate expansion", description: "Evaluate a candidate lead without running another provider.", access: "LOCAL" },
  { name: "osint-unit.retrieve-evidence", group: "OSINT INVESTIGATION", label: "Retrieve evidence", description: "Retrieve exact evidence records from a known investigation.", access: "LOCAL" },
  { name: "osint-unit.explain-claim-or-confidence", group: "OSINT INVESTIGATION", label: "Explain claim", description: "Explain confidence, support, contradictions, and limitations.", access: "LOCAL" },
  { name: "osint-unit.list-candidate-leads", group: "OSINT INVESTIGATION", label: "List candidate leads", description: "List unexecuted candidates and their evidence identifiers.", access: "LOCAL" },
  { name: "osint-unit.search-entities", group: "OSINT INVESTIGATION", label: "Search case entities", description: "Search normalized entities and aliases within one bounded investigation.", access: "LOCAL" },
  { name: "osint-unit.get-entity-profile", group: "OSINT INVESTIGATION", label: "Entity profile", description: "Retrieve one cited entity profile without direct database access.", access: "LOCAL" },
  { name: "osint-unit.get-entity-timeline", group: "OSINT INVESTIGATION", label: "Entity timeline", description: "Read time-ordered observations, claims, and relationships.", access: "LOCAL" },
  { name: "osint-unit.find-paths-between-entities", group: "OSINT INVESTIGATION", label: "Graph paths", description: "Find bounded evidence-backed paths between two entities.", access: "LOCAL" },
  { name: "osint-unit.compare-entities", group: "OSINT INVESTIGATION", label: "Compare identities", description: "Create a reversible POSSIBLY_SAME_AS assessment without merging.", access: "LOCAL" },
  { name: "osint-unit.retrieve-supporting-evidence", group: "OSINT INVESTIGATION", label: "Supporting evidence", description: "Retrieve evidence supporting one exact claim or hypothesis.", access: "LOCAL" },
  { name: "osint-unit.retrieve-contradictions", group: "OSINT INVESTIGATION", label: "Contradictions", description: "Retrieve explicit contradicting records and evidence.", access: "LOCAL" },
  { name: "osint-unit.identify-information-gaps", group: "OSINT INVESTIGATION", label: "Information gaps", description: "Identify missing information without starting collection.", access: "LOCAL" },
  { name: "osint-unit.run-pattern-detector", group: "OSINT INVESTIGATION", label: "Pattern detectors", description: "Run deterministic temporal, graph, anomaly, and source-quality checks.", access: "LOCAL" },
  { name: "osint-unit.search-geospatial-observations", group: "OSINT INVESTIGATION", label: "Geospatial case search", description: "Find observations near a place and time with coordinate uncertainty preserved.", access: "LOCAL" },
  { name: "osint-unit.run-quality-checks", group: "OSINT INVESTIGATION", label: "Evidence quality", description: "Check duplicates, timestamps, freshness, link state, lineage, and AI indicators.", access: "LOCAL" },
  { name: "osint-unit.build-source-lineage", group: "OSINT INVESTIGATION", label: "Source lineage", description: "Separate independent evidence from copied or circular records.", access: "LOCAL" },
  { name: "osint-unit.create-hypothesis", group: "OSINT INVESTIGATION", label: "Create hypothesis", description: "Create a cited candidate hypothesis that remains separate from facts.", access: "LOCAL" },
  { name: "osint-unit.test-hypothesis", group: "OSINT INVESTIGATION", label: "Test hypothesis", description: "Test a candidate against supporting and contradicting case records.", access: "LOCAL" },
  { name: "osint-unit.generate-collection-plan", group: "OSINT INVESTIGATION", label: "Collection plan", description: "Propose approval-required next steps without contacting providers.", access: "LOCAL" },
  { name: "osint-unit.calculate-confidence", group: "OSINT INVESTIGATION", label: "Calculate confidence", description: "Explain confidence, independence, freshness, conflicts, and limitations.", access: "LOCAL" },
  { name: "voidcat.search-project-memory", group: "VOIDCAT KNOWLEDGE", label: "Project memory", description: "Search explicit approved memories in the active project.", access: "LOCAL" },
  { name: "voidcat.search-rag-library", group: "VOIDCAT KNOWLEDGE", label: "RAG library", description: "Search enabled local document passages and citations.", access: "LOCAL" },
  { name: "voidcat.search-hunter-history", group: "VOIDCAT KNOWLEDGE", label: "Hunter history", description: "Search opt-in summaries and derived events across history and selected libraries.", access: "LOCAL" },
  { name: "voidcat.search-osint-directory", group: "VOIDCAT KNOWLEDGE", label: "OSINT directory", description: "Search the captured OSINT4ALL tool directory without contacting it.", access: "LOCAL" },
  { name: "voidcat.news-headlines", group: "VOIDCAT KNOWLEDGE", label: "News headlines", description: "Pull bounded fixed RSS feeds with caching, throttling, and source attribution.", access: "EXTERNAL" },
];
