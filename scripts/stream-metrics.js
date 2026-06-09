// Token/step accounting from `claude --output-format stream-json` (design §12 — the
// gem ported from v1's live-results.js parseStreamMetrics). The one change vs v1: it
// keeps the FOUR raw usage counts separate (input / cache_creation / cache_read /
// output) instead of collapsing them, because cell_metrics stores them separately and
// COST/EFFORT are derived from them at query time (never a pre-summed number).
//
// Used twice: by the supervisor (to detect the result event for clean early exit) and
// once by the orchestrator at build-end (to write cell_metrics).

import fs from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const ZERO = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };

// snake_case usage (assistant messages, result.usage, message_delta).
function usageBreakdown(usage) {
  return {
    input: usage?.input_tokens ?? 0,
    cacheCreation: usage?.cache_creation_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
  };
}

function sumOf(b) {
  return b.input + b.cacheCreation + b.cacheRead + b.output;
}

function addBreakdown(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    input: a.input + b.input,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

// camelCase per-model usage block on the terminal `result` event.
function modelUsageBreakdown(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  let saw = false;
  let total = null;
  for (const u of Object.values(modelUsage)) {
    const b = {
      input: u?.inputTokens ?? 0,
      cacheCreation: u?.cacheCreationInputTokens ?? 0,
      cacheRead: u?.cacheReadInputTokens ?? 0,
      output: u?.outputTokens ?? 0,
    };
    if (sumOf(b) > 0) saw = true;
    total = addBreakdown(total, b);
  }
  return saw ? total : null;
}

export async function parseStreamMetrics(streamFile) {
  const assistantUsageByMessage = new Map();
  let resultUsage = null;
  let aggregateResultUsage = null;
  let streamUsage = null;
  const toolUseIds = new Set();
  let anonymousToolUseCount = 0;
  let durationMs = null;
  let failed = false;
  let resultSeen = false;

  if (!fs.existsSync(streamFile)) {
    return { ...ZERO, steps: 0, durationMs, failed, resultSeen };
  }

  const rl = createInterface({ input: createReadStream(streamFile), crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim().replace(/^﻿/, "");
    if (!text) continue;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }

    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === "tool_use") {
          if (block.id) toolUseIds.add(block.id);
          else anonymousToolUseCount++;
        }
      }
    }
    if (obj.type === "assistant" && obj.message?.usage) {
      const key = obj.message.id || obj.request_id || obj.uuid;
      if (key) assistantUsageByMessage.set(key, usageBreakdown(obj.message.usage));
    }
    if (obj.type === "result") {
      resultSeen = true;
      const modelUsage = modelUsageBreakdown(obj.modelUsage);
      if (modelUsage) aggregateResultUsage = modelUsage;
      if (obj.usage) resultUsage = usageBreakdown(obj.usage);
      if (Number.isFinite(obj.duration_ms)) durationMs = obj.duration_ms;
      if (obj.is_error || obj.subtype === "error") failed = true;
    }

    // streaming events (when --verbose emits content_block / message_delta)
    const evt = obj.event ?? obj;
    if (evt.type === "message_delta" && evt.usage) {
      const next = usageBreakdown(evt.usage);
      if (!streamUsage || sumOf(next) >= sumOf(streamUsage)) streamUsage = next;
    }
    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      if (evt.content_block.id) toolUseIds.add(evt.content_block.id);
      else anonymousToolUseCount++;
    }
  }

  const assistantUsage = [...assistantUsageByMessage.values()].reduce(addBreakdown, null);
  const fallback = addBreakdown(assistantUsage, streamUsage);
  const usage = aggregateResultUsage ?? resultUsage ?? fallback ?? ZERO;

  return {
    input: usage.input,
    cacheCreation: usage.cacheCreation,
    cacheRead: usage.cacheRead,
    output: usage.output,
    steps: toolUseIds.size + anonymousToolUseCount,
    durationMs,
    failed,
    resultSeen,
  };
}
