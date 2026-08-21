#!/usr/bin/env node
import { Command } from "commander";
import { sync } from "./commands/sync.js";
import { list, type ListOpts } from "./commands/list.js";
import { startDashboard } from "./commands/dashboard.js";
import { doctor, welcome } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { loadConfig, isConfigured } from "./config.js";
import { warmClone } from "./fixer.js";

/** Guard commands that need repos: nudge unconfigured users to `dontpanic setup`. */
function requireConfigured(): boolean {
  if (isConfigured()) return true;
  console.log("\n  No repos configured yet. Run  dontpanic setup  to pick the repos to watch.\n");
  return false;
}

const program = new Command();
program.name("dontpanic").description("Learn agentic development on your real PR backlog — manage context, manage agents.").version("0.1.0");

// Guided onboarding: explain → check prerequisites (actionable) → configure → point to launch.
async function onboard(): Promise<void> {
  welcome();
  const ready = await doctor();
  if (!ready) {
    console.log("\n  Fix the ✗ items above, then run  dontpanic  again to finish setup.\n");
    return;
  }
  await runSetup(); // prompts on first run; no-op once configured
  console.log(
    isConfigured()
      ? "\n  ✓ You're all set. Start the dashboard:  dontpanic dashboard\n"
      : "\n  Add at least one repo with  dontpanic setup , then run  dontpanic dashboard .\n",
  );
}

// No subcommand → run the guided onboarding.
program.action(onboard);

program.command("onboard").description("Guided first-time setup: check prerequisites + configure").action(onboard);
program.command("setup").description("Set your GitHub login + repos to watch").action(() => runSetup(true));
program.command("doctor").description("Check prerequisites (gh, claude CLI, connectors)").action(async () => { await doctor(); });

program
  .command("sync")
  .description("Fetch open PRs (authored + review-requested) into the local store")
  .action(async () => {
    if (!requireConfigured()) return;
    await sync();
  });

program
  .command("list")
  .description("Show PRs grouped by whose turn it is")
  .option("--mine", "only PRs I authored")
  .option("--review", "only PRs assigned to me")
  .option("--turn <turn>", "filter to a single turn state")
  .action((opts: ListOpts) => list(opts));

program
  .command("prep")
  .description("Pre-clone the isolated fix-loop clones so the first fix run is fast")
  .action(async () => {
    for (const repo of loadConfig().repos) {
      process.stdout.write(`warming clone: ${repo} … `);
      try {
        const dir = await warmClone(repo);
        console.log(`ready (${dir.replace(process.env.HOME || "", "~")})`);
      } catch (e) {
        console.log(`failed: ${String((e as Error).message).slice(0, 120)}`);
      }
    }
  });

program
  .command("dashboard")
  .description("Start the dashboard — fetches PRs + calendar, then serves")
  .option("-p, --port <n>", "port", "4711")
  .option("--no-sync", "skip the startup sync (use existing data)")
  .option("--demo", "serve canned fixtures (no gh/claude, no spend) — for screenshots/trying the UI")
  .action(async (opts: { port: string; sync: boolean; demo?: boolean }) => {
    if (!opts.demo && !requireConfigured()) return;
    await startDashboard(Number(opts.port), opts.sync, opts.demo);
  });

program.parseAsync(process.argv);
