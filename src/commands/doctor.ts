import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, DIR } from "../config.js";

const execFileP = promisify(execFile);

async function check(label: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await fn();
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${label} — ${String((e as Error).message).split("\n")[0].slice(0, 90)}`);
    return false;
  }
}

/** What dontpanic is + the token deal. Shown when run with no command. */
export function welcome(): void {
  console.log(`
don'tpanic — a calm command center + coach for clearing your PR backlog.

When you run  dontpanic dashboard  it:
  • fetches your open PRs, the reviews you owe, and (on request) your calendar
  • picks the single highest-impact thing to work on — and tells you WHY
  • orients you on the issue, checks acceptance criteria, flags missing context
  • deploys + monitors an agent to review or fix it — you approve every write
  • teaches you something (CS / process) as you close each ticket

Tokens: GitHub data is FREE. AI reasoning — impact triage, full context, and the
review/fix agents — costs tokens, and dontpanic NEVER spends without you clicking a
clearly-priced button. Every button shows what it costs AND what fraction of your
daily limit that is; toggle the header between dollars and tokens. Spend and limit
are always in the header. Set your daily caps in ${DIR}/config.json ("budget").
`);
}

/** Verify prerequisites — the tools + connectors dontpanic drives. */
export async function doctor(): Promise<void> {
  console.log("Checking your setup:\n");
  await check("Node", async () => process.version);
  await check("claude CLI (the default agent dontpanic drives)", async () => (await execFileP("claude", ["--version"])).stdout.trim());
  await check("GitHub CLI authenticated", async () => {
    await execFileP("gh", ["auth", "status"]);
    return "gh is authed";
  });
  // Codex is optional — a second agent backend, offered in the cockpit only when present.
  try {
    const v = (await execFileP("codex", ["--version"])).stdout.trim();
    console.log(`  ✓ codex CLI (optional second agent) — ${v}`);
  } catch {
    console.log("  · codex CLI not found (optional) — install it to pick Codex as the review/fix agent");
  }

  const cfg = loadConfig();
  console.log(
    cfg.repos.length
      ? `\n  Watching repos: ${cfg.repos.join(", ")}  (as @${cfg.me || "?"})`
      : `\n  · No repos configured yet — run  dontpanic setup  to pick the repos to watch.`,
  );
  console.log(`
  dontpanic reaches Slack, Linear, and Google Calendar THROUGH the claude CLI's own
  connectors — no separate tokens. Make sure these are connected in your Claude account:
      • Slack   • Linear   • Google Calendar
  They're exercised (and thus verified) the first time you spend on context/triage.

  Run  dontpanic dashboard  to start.
`);
}
