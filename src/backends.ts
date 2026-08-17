// Agent backends. dontpanic can drive either Claude Code (`claude -p`) or Codex
// (`codex exec`). Claude is the default and the one validated here; Codex is spawned
// through the same interface and only offered when the `codex` CLI is present.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Backend = "claude" | "codex";

export function isBackend(v: unknown): v is Backend {
  return v === "claude" || v === "codex";
}

let _codex: boolean | null = null;
export async function codexAvailable(): Promise<boolean> {
  if (_codex !== null) return _codex;
  try { await execFileP("codex", ["--version"]); _codex = true; } catch { _codex = false; }
  return _codex;
}

export interface SpawnOpts {
  cwd?: string;
  allowedTools?: string; // claude only
  write?: boolean; // may the agent modify files in cwd?
}

/** Spawn a headless agent run for the chosen backend. */
export function spawnAgent(backend: Backend, prompt: string, opts: SpawnOpts): ChildProcess {
  if (backend === "codex") {
    // `codex exec` is non-interactive; --json streams JSONL events, the sandbox flag
    // gates writes, and --skip-git-repo-check lets the read-only review run outside a repo.
    const args = [
      "exec", "--json", "--color", "never", "--skip-git-repo-check",
      "--sandbox", opts.write ? "workspace-write" : "read-only",
      prompt,
    ];
    return spawn("codex", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  }
  // --include-partial-messages streams thinking/text token deltas so we can show ALL the
  // reasoning live, not just a truncated summary.
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  return spawn("claude", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export interface AgentEvent {
  reasoningDelta?: string; // thinking tokens to append to the live reasoning stream
  textDelta?: string; // output/narration tokens to append to the live answer stream
  toolCall?: string; // a tool invocation just started (its name)
  step?: string; // a discrete monitor line (codex, done markers)
  appendResult?: string; // text to accumulate into the final result (codex)
  resultText?: string; // the final result (claude only — from the result event)
  costUsd?: number; // reported cost, if any (claude reports USD; codex bills OpenAI separately)
  tokens?: number; // total tokens consumed (both backends report usage)
}

const clip = (s: string, n = 150) => s.trim().replace(/\s+/g, " ").slice(0, n);

// An ordered, human-readable breakdown of a run: reasoning paragraphs, tool calls, and
// output — accumulated from token deltas so the UI can render the full stream live.
export type SegmentKind = "reasoning" | "text" | "tool";
export interface Segment { kind: SegmentKind; text: string; }

function stepKind(step: string): SegmentKind {
  if (step.startsWith("↪")) return "tool";
  if (step.startsWith("💭") || step.startsWith("·")) return "reasoning";
  return "text";
}

/** Fold one AgentEvent into the ordered segment list (mutates `segs`). */
export function applyEvent(segs: Segment[], ev: AgentEvent): void {
  const appendSame = (kind: SegmentKind, text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segs.push({ kind, text });
  };
  if (ev.reasoningDelta) appendSame("reasoning", ev.reasoningDelta);
  if (ev.textDelta) appendSame("text", ev.textDelta);
  if (ev.toolCall) segs.push({ kind: "tool", text: ev.toolCall });
  if (ev.step) segs.push({ kind: stepKind(ev.step), text: ev.step });
  if (ev.appendResult) appendSame("text", ev.appendResult);
}

/** Normalize one stdout line from a backend into monitor/result events. */
export function parseLine(backend: Backend, line: string): AgentEvent[] {
  if (backend === "codex") {
    // `codex exec --json` emits JSONL: thread/turn lifecycle + item.{started,completed}.
    // The final agent_message is the result; command_execution items are the tool steps.
    // Usage reports tokens only — Codex bills the ChatGPT plan, so no USD cost is recorded.
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return []; }
    const out: AgentEvent[] = [];
    if (ev.type === "item.started" || ev.type === "item.completed") {
      const item = (ev.item as Record<string, unknown>) ?? {};
      if (item.type === "agent_message" && typeof item.text === "string") {
        // Each completed agent message overwrites the result; the last one wins.
        if (ev.type === "item.completed") out.push({ step: "💭 " + clip(item.text), resultText: item.text });
      } else if (item.type === "command_execution" && ev.type === "item.started") {
        out.push({ step: "↪ $ " + clip(String(item.command ?? "")) });
      } else if (item.type === "reasoning" && ev.type === "item.completed" && typeof item.text === "string") {
        out.push({ step: "· " + clip(item.text) });
      } else if (item.type === "file_change" && ev.type === "item.completed") {
        out.push({ step: "✎ edited files" });
      }
    } else if (ev.type === "turn.completed") {
      const u = (ev.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
      // input_tokens already includes any cached portion; don't double-count.
      const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      out.push({ step: `✓ done — ${u.output_tokens ?? 0} output tokens (billed to your ChatGPT plan)`, tokens });
    }
    return out;
  }
  // claude stream-json (with --include-partial-messages)
  let ev: Record<string, unknown>;
  try { ev = JSON.parse(line); } catch { return []; }
  const out: AgentEvent[] = [];
  if (ev.type === "stream_event") {
    // Token-level deltas: thinking (reasoning), text (output), and tool-use starts.
    const e = (ev.event as Record<string, unknown>) ?? {};
    if (e.type === "content_block_start") {
      const block = (e.content_block as Record<string, unknown>) ?? {};
      if (block.type === "tool_use" && typeof block.name === "string") out.push({ toolCall: block.name });
    } else if (e.type === "content_block_delta") {
      const d = (e.delta as Record<string, unknown>) ?? {};
      if (d.type === "thinking_delta" && typeof d.thinking === "string") out.push({ reasoningDelta: d.thinking });
      else if (d.type === "text_delta" && typeof d.text === "string") out.push({ textDelta: d.text });
    }
  } else if (ev.type === "result") {
    const u = ev.usage as Record<string, number> | undefined;
    // Anthropic reports cache tokens separately from input_tokens, so sum all four.
    const tokens = u
      ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      : undefined;
    out.push({ resultText: (ev.result as string) ?? "", costUsd: (ev.total_cost_usd as number) ?? undefined, tokens });
  }
  return out;
}
