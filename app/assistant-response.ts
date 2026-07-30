/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */

const HIDDEN_REASONING_TAG = /<\s*(\/?)\s*(think|analysis|reasoning)\b[^>]*>/gi;
const HIDDEN_TAG_FORMS = ["<think>", "</think>", "<analysis>", "</analysis>", "<reasoning>", "</reasoning>"];

function stripPartialHiddenTag(text: string) {
  const tagStart = text.lastIndexOf("<");
  if (tagStart < 0 || text.indexOf(">", tagStart) >= 0) return text;
  const candidate = text.slice(tagStart).toLowerCase().replace(/\s+/g, "");
  return HIDDEN_TAG_FORMS.some((tag) => tag.startsWith(candidate)) ? text.slice(0, tagStart) : text;
}

export function visibleAssistantResponse(rawContent: string) {
  let output = "";
  let cursor = 0;
  let hiddenDepth = 0;
  HIDDEN_REASONING_TAG.lastIndex = 0;
  for (let match = HIDDEN_REASONING_TAG.exec(rawContent); match; match = HIDDEN_REASONING_TAG.exec(rawContent)) {
    if (hiddenDepth === 0) output += rawContent.slice(cursor, match.index);
    hiddenDepth = match[1] ? Math.max(0, hiddenDepth - 1) : hiddenDepth + 1;
    cursor = match.index + match[0].length;
  }
  if (hiddenDepth === 0) output += rawContent.slice(cursor);
  return stripPartialHiddenTag(output).replace(HIDDEN_REASONING_TAG, "");
}

type ChatCompletionDelta = {
  choices?: Array<{
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
  }>;
};

export class AssistantResponseAccumulator {
  private rawContent = "";
  private hiddenReasoningCharacters = 0;

  append(event: unknown) {
    const delta = (event as ChatCompletionDelta | null)?.choices?.[0]?.delta;
    if (!delta) return this.visible;
    for (const hidden of [delta.reasoning_content, delta.reasoning]) {
      if (typeof hidden === "string") this.hiddenReasoningCharacters += hidden.length;
    }
    if (typeof delta.content === "string") this.rawContent += delta.content;
    return this.visible;
  }

  get visible() { return visibleAssistantResponse(this.rawContent); }
  get discardedReasoningCharacters() { return this.hiddenReasoningCharacters; }
  final() { return this.visible.trim(); }
}
