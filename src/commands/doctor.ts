import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, customText, CUSTOM_FILES, DIR } from "../config.js";

const execFileP = promisify(execFile);

/** Run a command, returning trimmed stdout, or null if it's missing/errors. */
async function tryCmd(cmd: string, args: string[], timeout = 15000): Promise<string | null> {
  try { return (await execFileP(cmd, args, { timeout })).stdout.trim(); }
  catch { return null; }
}

// The claude.ai connectors dontpanic drives (through the `claude` CLI, no separate tokens).
const CONNECTORS = ["Slack", "Linear", "Google Calendar"];

/** Connector connection status, read for FREE from `claude mcp list` (no model call). */
async function connectorStatus(): Promise<Record<string, boolean> | null> {
  const out = await tryCmd("claude", ["mcp", "list"], 45000);
  if (out === null) return null;
  const lines = out.split("\n");
  const st: Record<string, boolean> = {};
  for (const name of CONNECTORS) {
    const line = lines.find((l) => l.includes(`claude.ai ${name}:`));
    st[name] = !!line && /Connected|✔/.test(line);
  }
  return st;
}

/** What dontpanic is + the token deal. Shown at the top of onboarding. */
export function welcome(): void {
  console.log(`
don'tpanic — learn agentic development on your real PR backlog: how to manage
context, and how to manage agents.

Each task in  dontpanic dashboard  teaches the loop that matters:
  • MANAGE CONTEXT — gather what an agent needs, see what's missing, and read
    the exact prompt it will run
  • MANAGE AGENTS — launch a review/fix agent, watch its reasoning stream, and
    approve every write yourself (pick Claude or Codex per task)
  • MANAGE SPEND — every AI action is priced against your daily limit, so cost
    control becomes a habit
  • LEVEL UP — each task surfaces a CS/systems/process lesson from the real diff

It drives your own tools: GitHub via  gh , and reasoning/agents via the
 claude  CLI, reusing your claude.ai connectors (Slack, Linear, Calendar).
No tokens of its own. GitHub data is FREE; every AI action is a clearly-priced,
human-gated click (limit set in ${DIR}/config.json).
`);
}

/** Guided, actionable prerequisite check. Returns true if the critical tools are ready. */
export async function doctor(): Promise<boolean> {
  console.log("Checking your setup:\n");
  let ready = true;

  console.log(`  ✓ Node ${process.version}`);

  // GitHub CLI — required for all PR data.
  if ((await tryCmd("gh", ["--version"])) === null) {
    console.log("  ✗ GitHub CLI (gh) not found\n      → install it: https://cli.github.com");
    ready = false;
  } else if ((await tryCmd("gh", ["auth", "status"])) !== null) {
    console.log("  ✓ GitHub CLI — authenticated");
  } else {
    console.log("  ✗ GitHub CLI not signed in\n      → run: gh auth login");
    ready = false;
  }

  // Claude Code CLI — the agent dontpanic drives.
  const clv = await tryCmd("claude", ["--version"]);
  if (clv === null) {
    console.log("  ✗ Claude Code CLI (claude) not found\n      → install it: https://docs.claude.com/en/docs/claude-code");
    ready = false;
  } else {
    console.log(`  ✓ Claude Code CLI — ${clv}`);
    // Connectors are recommended (impact ranking, context, calendar), not strictly required.
    console.log("  … checking Claude connectors (this pings your integrations)…");
    const st = await connectorStatus();
    if (st === null) {
      console.log("  · Couldn't read connectors (`claude mcp list` failed) — check `claude` is signed in.");
    } else {
      for (const name of CONNECTORS) {
        console.log(
          st[name]
            ? `  ✓ Connector: ${name} — connected`
            : `  · Connector: ${name} — not connected (recommended)\n      → add it at claude.ai → Settings → Connectors`,
        );
      }
    }
  }

  const cfg = loadConfig();

  // Codex — an optional ALTERNATE agent for the review/fix code edits only. The reasoning
  // (impact ranking, context, briefs, calendar) always runs on Claude + its connectors.
  const cx = await tryCmd("codex", ["--version"]);
  if (cx) {
    console.log(`  ✓ codex CLI — ${cx} (can run review/fix; default agent: ${cfg.defaultAgent})`);
    if (cfg.defaultAgent === "codex") console.log("      Codex handles code edits; Claude still does impact ranking / context / briefs.");
  } else {
    console.log("  · codex CLI not found (optional) — install it to run review/fix on Codex instead of Claude");
  }

  console.log(
    cfg.repos.length
      ? `\n  Watching: ${cfg.repos.join(", ")}  (as @${cfg.me || "?"})`
      : "\n  · No repos configured yet — run  dontpanic setup .",
  );

  // Active prompt customizations (optional markdown files in the config dir).
  const active = Object.values(CUSTOM_FILES).filter((f) => customText(f));
  if (active.length) console.log(`  ✓ Custom prompts in use: ${active.join(", ")}`);
  else console.log(`  · No custom prompts — drop a prioritization.md or review-guidelines.md in ${DIR} to tailor the AI.`);

  return ready;
}
