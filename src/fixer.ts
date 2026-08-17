// The fix loop: for mine_fix / mine_respond tasks, run a write-capable agent in a
// DEDICATED ISOLATED CLONE (~/.dontpanic/clones, never the user's working clones),
// fixing CI / addressing review threads. The agent is told NOT to commit or push;
// dontpanic captures the working-tree diff. Pushing is a separate human-gated action.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CLONES_DIR } from "./config.js";
import { recordSpend } from "./spend.js";
import { spawnAgent, parseLine, applyEvent, type Backend, type Segment } from "./backends.js";
import { gatheredContextLines, type Gathered } from "./broker.js";
import { houseRulesLines } from "./agent.js";

const execFileP = promisify(execFile);

export type FixStatus = "running" | "proposed" | "pushed" | "failed";
export interface FixJob {
  id: string;
  repo: string;
  number: number;
  branch: string;
  status: FixStatus;
  steps: string[];
  segments: Segment[]; // live streamed reasoning / tool calls / output
  diff: string;
  diffStat: string;
  error: string | null;
  costUsd: number | null;
  tokens: number | null;
  cloneDir: string;
  startedAt: number;
  backend: Backend;
}

const jobs = new Map<string, FixJob>();
let seq = 0;
export const getFixJob = (id: string): FixJob | null => jobs.get(id) ?? null;

// Each repo has ONE isolated clone, so fixes on the SAME repo must not run concurrently
// (they'd clobber each other's working tree). This per-repo lock serializes same-repo
// fixes while letting fixes on DIFFERENT repos — and all reviews — run truly in parallel.
const repoLocks = new Map<string, Promise<void>>();
async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  repoLocks.set(repo, prev.then(() => next));
  await prev.catch(() => {}); // wait our turn (ignore a prior job's failure)
  try { return await fn(); }
  finally { release(); if (repoLocks.get(repo) === next) repoLocks.delete(repo); }
}

const cloneDirFor = (repo: string): string => join(CLONES_DIR, repo.replace("/", "__"));
// Strip control chars (except \n and \t) so job fields always serialize to valid JSON.
const stripCtl = (s: string): string => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function cloneCore(repo: string): Promise<{ dir: string; action: "cloned" | "fetched" }> {
  mkdirSync(CLONES_DIR, { recursive: true });
  const dir = cloneDirFor(repo);
  if (!existsSync(join(dir, ".git"))) {
    await sh("gh", ["repo", "clone", repo, dir, "--", "--filter=blob:none"]);
    return { dir, action: "cloned" };
  }
  await sh("git", ["fetch", "origin", "--prune"], dir);
  return { dir, action: "fetched" };
}

/** Pre-clone (or fetch) a repo so the first fix run isn't slow. Safe to call anytime. */
export async function warmClone(repo: string): Promise<string> {
  return (await cloneCore(repo)).dir;
}

async function ensureClone(repo: string, job: FixJob): Promise<string> {
  job.steps.push(`Preparing isolated clone of ${repo}…`);
  const { dir, action } = await cloneCore(repo);
  job.steps.push(action === "cloned" ? "Cloned (isolated, partial)." : "Isolated clone fetched to latest.");
  return dir;
}

// Shown in the copyable prompt in place of the (long) CI logs; the real logs are spliced
// in at launch, so the user sees/edits exactly what the agent runs.
export const CI_LOG_PLACEHOLDER = "[The failing CI logs (from `gh run view --log-failed`) are included here when the agent runs.]";

export function buildFixPrompt(repo: string, number: number, turn: string, ciLog: string, gathered?: Gathered | null): string {
  const guard = [
    ...houseRulesLines(), // your team's standards from ~/.dontpanic/review-guidelines.md
    ``,
    `## Ground rules`,
    ``,
    `- You are in an isolated clone of ${repo}, on the PR's branch. Make the change directly in the working tree.`,
    `- Do NOT run 'git commit' or 'git push' — leave your changes uncommitted so I can review them.`,
    `- Keep the change minimal and focused.`,
  ];
  const ctx = gatheredContextLines(gathered);
  if (turn === "mine_respond") {
    return [
      `# Address the unresolved review threads on PR ${repo}#${number}`,
      ``,
      `Use gh to read what reviewers asked for:`,
      ``,
      `- 'gh pr view ${number} --comments'`,
      `- 'gh api repos/${repo}/pulls/${number}/comments'`,
      ``,
      `Make exactly the changes reviewers requested. Do NOT weaken tests. Run the relevant tests if quick.`,
      ...ctx,
      ...guard,
    ].join("\n");
  }
  return [
    `# Fix the failing CI on PR ${repo}#${number}`,
    ``,
    `Reproduce and fix the ROOT CAUSE — do not weaken or delete assertions to make it pass. Run the relevant tests to confirm your fix if it's quick.`,
    ``,
    ciLog ? `## Failing CI logs (truncated)\n\n${ciLog}` : `Use 'gh run view --log-failed' to see the failing logs.`,
    ...ctx,
    ...guard,
  ].join("\n");
}

export function launchFixAgent(repo: string, number: number, turn: string, backend: Backend = "claude", gathered: Gathered | null = null, promptOverride?: string | null): FixJob {
  const id = `fix${++seq}_${number}`;
  const job: FixJob = {
    id, repo, number, branch: "", status: "running",
    steps: [`Preparing isolated clone… (${backend})`], segments: [], diff: "", diffStat: "",
    error: null, costUsd: null, tokens: null, cloneDir: "", startedAt: Date.now(), backend,
  };
  jobs.set(id, job);
  while (jobs.size > 50) jobs.delete(jobs.keys().next().value as string);
  run(job, turn, gathered, promptOverride ?? null).catch((e) => { job.status = "failed"; job.error = String(e?.message ?? e); });
  return job;
}

async function run(job: FixJob, turn: string, gathered: Gathered | null, promptOverride: string | null): Promise<void> {
  if (repoLocks.has(job.repo)) job.steps.push("Queued behind another fix on this repo (they share one clone)…");
  return withRepoLock(job.repo, () => runLocked(job, turn, gathered, promptOverride));
}

async function runLocked(job: FixJob, turn: string, gathered: Gathered | null, promptOverride: string | null): Promise<void> {
  const dir = await ensureClone(job.repo, job);
  job.cloneDir = dir;

  // Discard any leftover changes from a prior fix run so checkout is clean.
  await sh("git", ["reset", "--hard"], dir).catch(() => {});
  await sh("git", ["clean", "-fd"], dir).catch(() => {});

  job.steps.push(`Checking out PR #${job.number} in the isolated clone…`);
  await sh("gh", ["pr", "checkout", String(job.number)], dir);
  job.branch = (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();

  let ciLog = "";
  if (turn === "mine_fix") {
    try { ciLog = (await sh("gh", ["run", "view", "--log-failed"], dir)).slice(0, 20000); } catch { /* best effort */ }
  }

  job.steps.push("Deploying fix agent (isolated clone; it will NOT commit or push)…");
  const prompt = promptOverride
    ? (turn === "mine_fix" ? promptOverride.replace(CI_LOG_PLACEHOLDER, ciLog || "(CI logs unavailable — use `gh run view --log-failed`)") : promptOverride)
    : buildFixPrompt(job.repo, job.number, turn, ciLog, gathered);
  if (promptOverride) job.steps.push("Using your edited prompt.");
  const child = spawnAgent(job.backend, prompt, { cwd: dir, allowedTools: "Edit,Write,Read,Bash,Glob,Grep", write: true });
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } }, 600_000);

  let buf = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const ev of parseLine(job.backend, line)) {
        applyEvent(job.segments, ev); // live reasoning / tool / output stream
        if (ev.costUsd !== undefined || ev.tokens !== undefined) {
          if (ev.costUsd !== undefined) job.costUsd = ev.costUsd;
          if (ev.tokens !== undefined) job.tokens = (job.tokens ?? 0) + ev.tokens;
          recordSpend("fix", ev.costUsd, ev.tokens);
        }
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
  await new Promise<void>((res) => child.on("close", () => res()));
  clearTimeout(killer);

  job.diffStat = stripCtl((await sh("git", ["diff", "--stat"], dir)).trim());
  job.diff = stripCtl(await sh("git", ["diff"], dir)).slice(0, 80000);
  if (job.diffStat) {
    job.status = "proposed";
    job.steps.push("✓ Proposed a diff — review it, then push when you're happy.");
  } else {
    job.status = "failed";
    job.error = job.error || stderr.slice(0, 300) || "agent produced no changes";
    job.steps.push("No changes produced.");
  }
}

/** Human-gated: commit the agent's working-tree changes and push to the PR branch. */
export async function pushFix(id: string, message: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) throw new Error("no such job");
  if (job.status !== "proposed") throw new Error("not in a proposed state");
  if (!job.cloneDir.startsWith(CLONES_DIR)) throw new Error("refusing to push from a non-isolated clone");
  await sh("git", ["add", "-A"], job.cloneDir);
  await sh("git", ["commit", "-m", message || "fix via dontpanic"], job.cloneDir);
  await sh("git", ["push", "origin", "HEAD"], job.cloneDir);
  job.status = "pushed";
  job.steps.push("✓ Pushed to " + job.branch + ".");
}
