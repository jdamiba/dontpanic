import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, DIR } from "../config.js";

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
don'tpanic — a calm command center + coach for clearing your PR backlog.

When you run  dontpanic dashboard  it:
  • fetches your open PRs, the reviews you owe, and (on request) your calendar
  • picks the single highest-impact thing to work on — and tells you WHY
  • briefs you on each PR's state + the changes it needs
  • deploys + monitors an agent to review or fix it — you approve every write

It drives your own tools: GitHub via  gh , and reasoning/agents via the
 claude  CLI, reusing your claude.ai connectors (Slack, Linear, Calendar).
No tokens of its own. GitHub data is FREE; every AI action is a clearly-priced,
human-gated click, shown against your daily limit (set in ${DIR}/config.json).
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

  // Codex — optional second agent backend.
  const cx = await tryCmd("codex", ["--version"]);
  console.log(cx ? `  ✓ codex CLI (optional second agent) — ${cx}` : "  · codex CLI not found (optional second agent)");

  const cfg = loadConfig();
  console.log(
    cfg.repos.length
      ? `\n  Watching: ${cfg.repos.join(", ")}  (as @${cfg.me || "?"})`
      : "\n  · No repos configured yet — run  dontpanic setup .",
  );
  return ready;
}
