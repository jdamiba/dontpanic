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
program.name("dontpanic").description("A calm command center + coach for clearing your agentic backlog").version("0.1.0");

// No subcommand → explain what this is + the token deal, run first-time setup, check prerequisites.
program.action(async () => {
  welcome();
  await runSetup(); // prompts only on first run
  await doctor();
});

program.command("setup").description("Set your GitHub login + repos to watch").action(() => runSetup(true));
program.command("doctor").description("Check prerequisites (claude CLI, gh auth, connectors)").action(doctor);

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
  .action(async (opts: { port: string; sync: boolean }) => {
    if (!requireConfigured()) return;
    await startDashboard(Number(opts.port), opts.sync);
  });

program.parseAsync(process.argv);
