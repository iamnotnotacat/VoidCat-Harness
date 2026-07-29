/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { DiscoveredTool } from "../voidcat-tool-registry.ts";
import type { OsintUnitToolResult } from "./osint-unit-tools.ts";

export type OsintModelToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function alias(name: string) { return name.replace(/^osint-unit\./, "osint_").replaceAll("-", "_"); }
export function osintToolAlias(name: string) { return alias(name); }
export function registryNameForOsintAlias(value: string, discovered: DiscoveredTool[]) { return discovered.find((tool) => alias(tool.name) === value)?.name; }

export function osintToolsForModel(discovered: DiscoveredTool[]) {
  return discovered.map((tool) => ({ type: "function" as const, function: { name: alias(tool.name), description: tool.description, parameters: tool.inputSchema } }));
}

export function osintToolSystemBoundary(discovered: DiscoveredTool[]) {
  return [
    "VOIDCAT OSINT TOOL BOUNDARY:",
    "Use only the registered high-level tools below. Never request, name, or choose a raw provider or API.",
    "Every factual conclusion must cite exact evidence identifiers as [EV:evidence_id]. Observation or entity identifiers alone are not evidence citations.",
    "If evidence does not support a conclusion, mark it [UNSUPPORTED — NO EVIDENCE ID]. Never invent evidence, provider coverage, authorization, or investigation IDs.",
    "Candidate leads are unverified and cannot run automatically. Expansion requires a separate operator approval.",
    "Exposure checks require a current one-time authorization created by the operator outside the UNIT.",
    "Respect returned coverage limitations and distinguish provider failure from evidence of absence.",
    ...discovered.map((tool) => `- ${alias(tool.name)}: ${tool.description}`),
  ].join("\n");
}

function evidenceIds(results: unknown[]) {
  const ids = new Set<string>();
  for (const result of results) {
    const value = result as Partial<OsintUnitToolResult>;
    value.evidence?.forEach(({ id }) => ids.add(id)); value.citations?.forEach(({ evidenceId }) => ids.add(evidenceId));
  }
  return ids;
}

function factualLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^[-*]\s*(?:limitations?|coverage|unsupported)\b/i.test(trimmed)) return false;
  return /[A-Za-z]{3}/.test(trimmed) && /(?:\bis\b|\bare\b|\bwas\b|\bwere\b|\bhas\b|\bhave\b|\bfound\b|\bshows?\b|\bindicates?\b|\bobserved\b|\buses?\b|\bbelongs?\b|\bassociated\b|\bexposed\b|\breturned\b|\bproduced\b|\bconfidence\b|\bcontrols?\b|\bowns?\b|\bhosts?\b|\bruns?\b|\bresolves?\b|\blocated\b)/i.test(trimmed);
}

export function markUncitedOsintConclusions(content: string, results: unknown[]) {
  const known = evidenceIds(results);
  return content.split("\n").map((line) => line.split(/(?<=[.!?])\s+(?!\[UNSUPPORTED)/).map((sentence) => {
    if (!factualLine(sentence) || /\[UNSUPPORTED\s*[—-]\s*NO EVIDENCE ID\]/i.test(sentence)) return sentence;
    const cited = [...sentence.matchAll(/\[EV:([^\]]+)\]/g)].map((match) => match[1]);
    return cited.some((id) => known.has(id)) ? sentence : `${sentence} [UNSUPPORTED — NO EVIDENCE ID]`;
  }).join(" ")).join("\n");
}

export function validateOsintCitations(content: string, results: unknown[]) {
  const known = evidenceIds(results); const cited = [...content.matchAll(/\[EV:([^\]]+)\]/g)].map((match) => match[1]); const unknown = [...new Set(cited.filter((id) => !known.has(id)))];
  const uncited = content.split("\n").flatMap((line) => line.split(/(?<=[.!?])\s+(?!\[UNSUPPORTED)/)).filter((sentence) => factualLine(sentence) && !/\[EV:[^\]]+\]|\[UNSUPPORTED\s*[—-]\s*NO EVIDENCE ID\]/i.test(sentence));
  return { valid: unknown.length === 0 && uncited.length === 0, citedEvidenceIds: [...new Set(cited)], unknownEvidenceIds: unknown, uncitedConclusions: uncited };
}

export function renderOsintEvidenceFallback(results: unknown[]) {
  const values = results.filter((item): item is OsintUnitToolResult => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const lines = ["## Bounded OSINT result"];
  for (const value of values) {
    lines.push("", `- ${value.summary}`);
    for (const claim of value.claims.slice(0, 12)) lines.push(`- ${claim.statement} ${claim.evidenceIds.map((id) => `[EV:${id}]`).join(" ") || "[UNSUPPORTED — NO EVIDENCE ID]"}`);
    for (const lead of value.candidateLeads.slice(0, 12)) lines.push(`- CANDIDATE ONLY: ${lead.type} ${lead.label ?? lead.value} — ${lead.reason} ${lead.evidenceIds.map((id) => `[EV:${id}]`).join(" ") || "[UNSUPPORTED — NO EVIDENCE ID]"}`);
    if (!value.claims.length && value.evidence.length) for (const evidence of value.evidence.slice(0, 12)) lines.push(`- ${evidence.title} [EV:${evidence.id}]`);
    value.coverageLimitations.slice(0, 8).forEach((limitation) => lines.push(`- Coverage limitation: ${limitation}`));
    if (value.nextAction) lines.push(`- Next action: ${value.nextAction}`);
  }
  return lines.join("\n");
}

function lastMatch(text: string, pattern: RegExp) { return text.match(pattern)?.[1]; }
export function inferredOsintToolCall(userText: string, discovered: DiscoveredTool[]): OsintModelToolCall | undefined {
  const text = userText.trim(); if (!text) return undefined;
  let registryName: string | undefined; let args: Record<string, unknown> = {};
  const investigationId = lastMatch(text, /\b(?:investigation|investigation id)\s*[:=#]?\s*([a-z0-9_-]{8,160})/i);
  const evidenceId = lastMatch(text, /\b(?:evidence|evidence id)\s*[:=#]?\s*([a-z0-9_-]{8,160})/i);
  const claimId = lastMatch(text, /\b(?:claim|claim id)\s*[:=#]?\s*([a-z0-9_-]{8,160})/i);
  const leadId = lastMatch(text, /\b(?:lead|lead id)\s*[:=#]?\s*([a-z0-9_-]{8,160})/i);
  if (/\blist\b.*\bcandidate leads?\b/i.test(text) && investigationId) { registryName = "osint-unit.list-candidate-leads"; args = { investigationId }; }
  else if (/\bretrieve\b.*\bevidence\b/i.test(text) && investigationId && evidenceId) { registryName = "osint-unit.retrieve-evidence"; args = { investigationId, evidenceIds: [evidenceId] }; }
  else if (/\bexplain\b.*\b(?:claim|confidence)\b/i.test(text) && investigationId && claimId) { registryName = "osint-unit.explain-claim-or-confidence"; args = { investigationId, claimId }; }
  else if (/\bexpand\b/i.test(text) && investigationId && leadId) { registryName = "osint-unit.expand-entity"; args = { investigationId, leadId }; }
  else {
    const observationId = lastMatch(text, /\b(?:observation|event)(?:\s+id)?\s*[:=#]\s*([a-z0-9:._-]{4,160})/i);
    const ip = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
    const domain = text.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/i)?.[0];
    const email = text.match(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/)?.[0];
    const username = lastMatch(text, /\busername\s*(?:is|[:=#])?\s*["']?([\p{L}\p{N}_.@-]{2,100})/iu);
    const organization = lastMatch(text, /\borganization\s*(?:is|[:=#])?\s*["']([^"']{2,200})["']/i);
    if (/\bexposure|breach|pwned\b/i.test(text) && (email || domain)) { registryName = "osint-unit.authorized-exposure-check"; args = { targetType: email ? "email-address" : "domain", exactTarget: email ?? domain }; }
    else if (/\bhunter\b/i.test(text) && observationId) { registryName = "osint-unit.investigate-hunter-event"; args = { observationId }; }
    else if (/\binfrastructure\b/i.test(text) && (ip || domain)) { registryName = "osint-unit.investigate-infrastructure"; args = { targetType: ip ? "ip-address" : "domain", target: ip ?? domain }; }
    else if (/\busername\b/i.test(text) && username) { registryName = "osint-unit.investigate-username"; args = { username }; }
    else if (/\borganization\b/i.test(text) && organization) { registryName = "osint-unit.investigate-organization"; args = { organization }; }
    else if (/\bpassive\b.*\bsearch|\bsearch\b.*\bpassive\b/i.test(text)) { registryName = "osint-unit.search-passive-web-sources"; args = { query: text.slice(0, 500) }; }
    else if (ip) { registryName = "osint-unit.investigate-ip"; args = { ipAddress: ip }; }
    else if (domain) { registryName = "osint-unit.investigate-domain"; args = { domain }; }
  }
  if (!registryName || !discovered.some((tool) => tool.name === registryName)) return undefined;
  return { id: `voidcat-osint-fallback-${Date.now().toString(36)}`, type: "function", function: { name: alias(registryName), arguments: JSON.stringify(args) } };
}
