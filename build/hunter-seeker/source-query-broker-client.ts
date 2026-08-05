/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryInput } from "./source-query.ts";

const MAX_BROKER_RESPONSE_BYTES = 8_000_000;

export async function queryHunterCredentialBroker(input: HunterSourceQueryInput, signal: AbortSignal) {
  const port = Number(process.env.VOIDCAT_OSINT_BROKER_PORT);
  const token = process.env.VOIDCAT_DESKTOP_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) throw new Error("The protected Hunter-Seeker credential broker is unavailable. Run VoidCat through its desktop launcher.");
  const response = await fetch(`http://127.0.0.1:${port}/hunter/query`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "Content-Type": "application/json", "X-VoidCat-Desktop-Token": token },
    body: JSON.stringify(input),
  });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BROKER_RESPONSE_BYTES) throw new Error("The protected provider response exceeded the Hunter-Seeker safety limit.");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BROKER_RESPONSE_BYTES) throw new Error("The protected provider response exceeded the Hunter-Seeker safety limit.");
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error("The protected provider broker returned malformed JSON."); }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "The protected provider request failed.";
    throw new Error(message);
  }
  return payload;
}
