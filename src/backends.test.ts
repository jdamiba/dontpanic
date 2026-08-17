import { describe, it, expect } from "vitest";
import { parseLine, applyEvent, type Segment } from "./backends.js";

/** Fold a list of raw stdout lines into the accumulated segments + final result. */
function run(backend: "claude" | "codex", lines: string[]) {
  const segs: Segment[] = [];
  let finalText = "";
  let cost: number | undefined;
  let tokens = 0;
  for (const line of lines) {
    for (const ev of parseLine(backend, line)) {
      applyEvent(segs, ev);
      if (ev.resultText !== undefined) finalText = ev.resultText;
      else if (ev.appendResult) finalText += ev.appendResult;
      if (ev.costUsd !== undefined) cost = ev.costUsd;
      if (ev.tokens !== undefined) tokens += ev.tokens;
    }
  }
  return { segs, finalText, cost, tokens };
}

describe("claude stream parsing (--include-partial-messages)", () => {
  it("accumulates thinking deltas into one reasoning segment, preserving newlines", () => {
    const { segs } = run("claude", [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "First line. " } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Still line one.\nSecond paragraph." } } }),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("reasoning");
    expect(segs[0].text).toBe("First line. Still line one.\nSecond paragraph.");
  });

  it("separates reasoning, tool calls, and text into ordered segments", () => {
    const { segs } = run("claude", [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "thinking…" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Grep" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } } }),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["reasoning", "tool", "text"]);
    expect(segs[1].text).toBe("Grep");
  });

  it("takes finalText, cost, and summed tokens from the result event", () => {
    const { finalText, cost, tokens } = run("claude", [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } }),
      JSON.stringify({ type: "result", result: "FINAL", total_cost_usd: 0.2, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }),
    ]);
    expect(finalText).toBe("FINAL");
    expect(cost).toBe(0.2);
    expect(tokens).toBe(125);
  });

  it("ignores non-streaming events (system/assistant) so text isn't double-counted", () => {
    const { segs } = run("claude", [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "should be ignored" }] } }),
    ]);
    expect(segs).toHaveLength(0);
  });

  it("returns nothing for malformed JSON lines", () => {
    expect(parseLine("claude", "not json")).toEqual([]);
    expect(parseLine("claude", "")).toEqual([]);
  });
});

describe("codex JSONL parsing", () => {
  it("maps command_execution to a tool segment and agent_message to the result", () => {
    const { segs, finalText, tokens } = run("codex", [
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "rg foo" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "DONE" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }),
    ]);
    expect(segs.some((s) => s.kind === "tool")).toBe(true);
    expect(finalText).toBe("DONE");
    expect(tokens).toBe(14);
  });
});
