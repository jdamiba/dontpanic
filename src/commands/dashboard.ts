import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allPrs, type StoredPr } from "../db.js";
import { loadConfig, saveConfig } from "../config.js";
import { pickOneTask, rankTasks, isActionable, scheduleDay, parseHM, DAY_START } from "../planner.js";
import { assembleContext } from "../context.js";
import { launchReviewAgent, getJob, submitReview, buildReviewPrompt, DIFF_PLACEHOLDER } from "../agent.js";
import { gatherContext, gatherDay, gatherMeeting, prioritize, draftPing, sendPing, peekContext, contextImpactLine, briefPr, peekBrief, EMPTY_GATHERED, type Meeting, type Brief } from "../broker.js";
import { launchFixAgent, getFixJob, pushFix, warmClone, buildFixPrompt, CI_LOG_PLACEHOLDER } from "../fixer.js";
import { ghText } from "../gh.js";
import { sync } from "./sync.js";
import { spendSummary, estimates } from "../spend.js";
import { codexAvailable, isBackend, type Backend } from "../backends.js";

// Explicit ?agent= wins; otherwise fall back to the user's configured default agent.
const pickBackend = (v?: string): Backend => (isBackend(v) ? v : loadConfig().defaultAgent);

let lastSyncAt = 0;
let syncing = false; // guards against overlapping manual + scheduled syncs
async function runSync(): Promise<void> {
  await sync();
  lastSyncAt = Date.now();
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Per-turn display label + a rough duration estimate (minutes) for the day timeline.
const KIND: Record<string, string> = {
  mine_review: "Review", mine_respond: "Respond", mine_fix: "Fix CI",
  ready_merge: "Merge", mine_request_review: "Assign",
};
const EST_MINS: Record<string, number> = {
  mine_review: 20, mine_respond: 15, mine_fix: 15, ready_merge: 5, mine_request_review: 5,
};

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Today if a weekday, else the next Monday (so the plan is a real working day). */
function targetDate(): { iso: string; label: string } {
  const d = new Date();
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() + 2);
  else if (dow === 0) d.setDate(d.getDate() + 1);
  const label = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return { iso: isoDate(d), label };
}

/** A one-line summary of my authored PRs by state, for auto-drafting a standup. */
function standupContext(): string {
  const mine = allPrs("author");
  const tag = (t: string) =>
    mine.filter((p) => p.turn === t)
      .map((p) => (p.repo.split("/").pop() || p.repo) + "#" + p.number)
      .slice(0, 10);
  const j = (a: string[]) => (a.length ? a.join(", ") : "none");
  return `In review (waiting on others): ${j(tag("theirs_review"))}. Need my fix (CI/conflict): ${j(tag("mine_fix"))}. Comments to address: ${j(tag("mine_respond"))}. Ready to merge: ${j(tag("ready_merge"))}.`;
}

/** Resolve a task by "repo#number" (or short "webapp#123"); default to pickOneTask. */
function findTask(selector?: string): StoredPr | null {
  const rows = allPrs();
  if (selector) {
    const [repoPart, numPart] = selector.split("#");
    const n = Number(numPart);
    const found = rows.find(
      (r) => isActionable(r) && r.number === n && (r.repo === repoPart || r.repo.split("/").pop() === repoPart),
    );
    if (found) return found;
  }
  return pickOneTask(rows);
}

function parse(p: StoredPr) {
  return {
    repo: p.repo,
    shortRepo: p.repo.split("/").pop(),
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author,
    turn: p.turn,
    ci: p.ci_status,
    mergeable: p.mergeable_state,
    reviewDecision: p.review_decision,
    reviewers: JSON.parse(p.requested_reviewers || "[]") as string[],
    lastCommitAt: p.last_commit_at,
    updatedAt: p.gh_updated_at,
  };
}

export async function startDashboard(port: number, syncOnStart = true): Promise<void> {
  if (syncOnStart) {
    console.log("Fetching your responsibilities, requests, and calendar (free — GitHub only)…");
    try { await runSync(); } catch (e) { console.log("  (sync failed, using last data): " + String((e as Error).message).slice(0, 80)); }
  }

  const app = Fastify({ logger: false });

  // Static assets live next to the compiled file (dist) or the source (tsx).
  const pub = join(__dirname, "public");
  await app.register(fastifyStatic, { root: pub, prefix: "/" });

  // Pretty route for the cockpit page.
  app.get("/now", (_req, reply) => reply.sendFile("now.html"));
  app.get("/parallel", (_req, reply) => reply.sendFile("parallel.html"));

  // Token spend + last-sync, for the always-visible transparency meter.
  app.get("/api/status", async () => {
    const cfg = loadConfig();
    const codex = await codexAvailable();
    // If the configured default is codex but it's not installed, fall back to claude.
    const defaultAgent = cfg.defaultAgent === "codex" && !codex ? "claude" : cfg.defaultAgent;
    return { ...spendSummary(), est: estimates(), autoSpend: cfg.autoSpend, defaultAgent, lastSyncAt, codex };
  });

  // Pull fresh PRs from GitHub on demand (free — gh only). Reprioritization stays a
  // separate paid click. Serialized against the scheduled sync via a single in-flight guard.
  app.post("/api/sync", async (reply) => {
    if (syncing) return { alreadyRunning: true, lastSyncAt };
    syncing = true;
    try { await runSync(); return { ok: true, lastSyncAt }; }
    catch (e) { return { error: String((e as Error).message).slice(0, 120), lastSyncAt }; }
    finally { syncing = false; }
  });

  // Flip auto-spend on/off. Auto-spend only covers reasoning reads (prioritize / gather
  // / rank); agent launches and any write (submit / push / send) stay explicit regardless.
  app.post<{ Body: { autoSpend?: boolean } }>("/api/settings", async (req) => {
    const cfg = loadConfig();
    if (typeof req.body?.autoSpend === "boolean") { cfg.autoSpend = req.body.autoSpend; saveConfig(cfg); }
    return { autoSpend: cfg.autoSpend };
  });

  app.get("/api/prs", async () => {
    const cfg = loadConfig();
    return {
      me: cfg.me,
      mine: allPrs("author").map(parse),
      review: allPrs("reviewer").map(parse),
    };
  });

  // The day's plan: real calendar meetings + the ranked tasks that fit in 8h of
  // focused work, scheduled into a timeline. The rest are deferred to tomorrow.
  app.get<{ Querystring: { cal?: string } }>("/api/plan", async (req) => {
    const withCal = req.query.cal === "1"; // calendar is a paid agent call — only on request
    const ranked = rankTasks(allPrs()).map((t) => ({
      type: "task" as const,
      ...parse(t),
      kind: KIND[t.turn] ?? t.turn,
      mins: EST_MINS[t.turn] ?? 15,
    }));
    const { iso, label } = targetDate();
    let meetings: Meeting[] = [];
    if (withCal) {
      try { meetings = await gatherDay(iso, label); } catch { meetings = []; }
    }

    // Plan from the current time when the target day is today — 9:00 slots help
    // nobody at 11. Meetings already over drop off; an in-progress one still leads.
    const now = new Date();
    const isToday = iso === isoDate(now);
    const nowMin = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
    if (isToday) meetings = meetings.filter((m) => parseHM(m.end) > nowMin);
    const startMin = isToday ? Math.max(DAY_START, nowMin) : DAY_START;

    const { day, focusUsed, courtZero, deferred } = scheduleDay(ranked, meetings, startMin);
    return { date: label, day, focusMins: focusUsed, deferred, courtZero, meetingCount: meetings.length, calendar: withCal };
  });

  // Impact-first prioritization: which task to close now, and why. Reasoned over
  // the top candidates using Slack + Linear (customer/incident signal). Cached.
  app.post("/api/priority", async () => {
    const cands = rankTasks(allPrs()).slice(0, 12).map((t) => ({
      key: `${t.repo.split("/").pop()}#${t.number}`,
      title: t.title,
      turn: t.turn,
      author: t.author,
      // Reuse any already-gathered context so the rerank searches less (fewer tokens).
      context: contextImpactLine(peekContext(t.repo, t.number, t.gh_updated_at)),
    }));
    if (!cands.length) return { ranked: [], topKey: "", topReason: "" };
    try {
      return await prioritize(cands);
    } catch {
      return { ranked: [], topKey: "", topReason: "" }; // Now view falls back to heuristic
    }
  });

  // Per-PR technical brief (state + suggested changes) for the Board's top items.
  const rowForKey = (rows: StoredPr[], key: string): StoredPr | null => {
    const [repoPart, numPart] = key.split("#");
    const n = Number(numPart);
    return rows.find((r) => r.number === n && (r.repo === repoPart || r.repo.split("/").pop() === repoPart)) ?? null;
  };
  // Peek only — returns already-generated briefs (free), for showing them on Board load.
  app.get<{ Querystring: { keys?: string } }>("/api/briefs", async (req) => {
    const rows = allPrs();
    const briefs: Record<string, Brief> = {};
    for (const key of (req.query.keys || "").split(",").filter(Boolean)) {
      const row = rowForKey(rows, key);
      if (!row) continue;
      const b = peekBrief(row.repo, row.number, row.gh_updated_at);
      if (b) briefs[key] = b;
    }
    return { briefs };
  });
  // Generate (paid) any missing briefs for the given keys; cached ones return free. Parallel.
  app.post<{ Body: { keys?: string[] } }>("/api/briefs", async (req) => {
    const rows = allPrs();
    const keys = (req.body?.keys ?? []).slice(0, 10);
    const entries = await Promise.all(keys.map(async (key): Promise<[string, Brief | null]> => {
      const row = rowForKey(rows, key);
      if (!row) return [key, null];
      try {
        const diff = await ghText(["pr", "diff", String(row.number), "--repo", row.repo, "--patch"]).catch(() => "");
        const b = await briefPr(row.repo, row.number, row.turn, row.title, diff, row.ci_status || "unknown", row.unresolved_threads ?? 0, row.gh_updated_at);
        return [key, b];
      } catch { return [key, null]; }
    }));
    const briefs: Record<string, Brief> = {};
    for (const [key, b] of entries) if (b) briefs[key] = b;
    return { briefs };
  });

  // Meeting detail + prep (auto-drafted standup / interview prep), via calendar auth.
  app.get<{ Querystring: { id?: string } }>("/api/meeting", async (req) => {
    if (!req.query.id) return { error: "no id" };
    try {
      return await gatherMeeting(req.query.id, standupContext());
    } catch {
      return { error: "meeting details unavailable right now" };
    }
  });

  // The "Now" cockpit: one task (chosen or top) + its real, summarized context.
  app.get<{ Querystring: { task?: string } }>("/api/now", async (req) => {
    const task = findTask(req.query.task);
    if (!task) return { task: null };
    const context = await assembleContext(task);
    return { task: parse(task), context };
  });

  // Enrich the selected task's context with REAL Slack + Linear, fetched live via
  // the agent's own auth (claude -p + scoped MCP). Cached per PR.
  app.post<{ Querystring: { task?: string } }>("/api/now/enrich", async (req) => {
    const task = findTask(req.query.task);
    if (!task) return { error: "court clear" };
    const diff = await ghText(["pr", "diff", String(task.number), "--repo", task.repo, "--patch"]).catch(() => "");
    try {
      return await gatherContext(task.repo, task.number, task.title, diff, task.gh_updated_at);
    } catch {
      return EMPTY_GATHERED;
    }
  });

  // Deploy → monitor → inspect. Launch is read-only (claude -p, no writes).
  // The exact prompt the review agent will receive — for display/copy. The full diff is
  // shown as a compact placeholder (it's spliced in at launch) so the textarea stays usable;
  // gathered context (if any) is folded in, mirroring the launched prompt.
  app.get<{ Querystring: { task?: string } }>("/api/now/prompt", async (req) => {
    const task = findTask(req.query.task);
    if (!task) return { error: "court clear" };
    const gathered = peekContext(task.repo, task.number, task.gh_updated_at);
    if (task.turn === "mine_fix" || task.turn === "mine_respond") {
      const ciLog = task.turn === "mine_fix" ? CI_LOG_PLACEHOLDER : "";
      return { prompt: buildFixPrompt(task.repo, task.number, task.turn, ciLog, gathered), gathered: !!gathered };
    }
    const context = await assembleContext(task);
    return { prompt: buildReviewPrompt(context, DIFF_PLACEHOLDER, gathered), gathered: !!gathered };
  });

  app.post<{ Querystring: { task?: string; agent?: string }; Body: { prompt?: string } }>("/api/now/launch", async (req) => {
    const task = findTask(req.query.task);
    if (!task) return { error: "court clear" };
    const backend = pickBackend(req.query.agent);
    if (backend === "codex" && !(await codexAvailable())) return { error: "codex CLI not installed" };
    const context = await assembleContext(task);
    const gathered = peekContext(task.repo, task.number, task.gh_updated_at); // reuse gathered context if present (free)
    const job = launchReviewAgent(context, backend, gathered, req.body?.prompt); // run the user's edited prompt if provided
    return { jobId: job.id };
  });

  // Fix loop: agent fixes CI / addresses threads in an isolated clone (mine_fix / mine_respond).
  app.post<{ Querystring: { task?: string; agent?: string }; Body: { prompt?: string } }>("/api/now/fix", async (req, reply) => {
    const task = findTask(req.query.task);
    if (!task) return { error: "court clear" };
    if (task.turn !== "mine_fix" && task.turn !== "mine_respond") {
      return reply.code(400).send({ error: "fix loop only handles mine_fix / mine_respond tasks" });
    }
    const backend = pickBackend(req.query.agent);
    if (backend === "codex" && !(await codexAvailable())) return reply.code(400).send({ error: "codex CLI not installed" });
    const gathered = peekContext(task.repo, task.number, task.gh_updated_at); // reuse gathered context if present (free)
    const job = launchFixAgent(task.repo, task.number, task.turn, backend, gathered, req.body?.prompt); // run the user's edited prompt if provided
    return { jobId: job.id };
  });

  app.get<{ Params: { id: string } }>("/api/fix/:id", async (req, reply) => {
    const job = getFixJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "no such job" });
    return job;
  });

  // Human-gated: commit + push the agent's changes to the PR branch.
  app.post<{ Params: { id: string }; Body: { message?: string } }>("/api/fix/:id/push", async (req, reply) => {
    try {
      await pushFix(req.params.id, req.body?.message ?? "");
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  });

  // Close the human loop. Draft is read-only (search + write text). Send is a WRITE.
  app.post<{ Body: { task?: string; kind?: string; gist?: string } }>("/api/ping/draft", async (req) => {
    const t = findTask(req.body.task);
    if (!t) return { error: "no task" };
    const kind = req.body.kind === "respond" ? "respond" : "review";
    let login = "";
    if (kind === "review") {
      login = t.author;
    } else {
      const cr = (JSON.parse(t.latest_reviews || "[]") as Array<{ who: string; state: string }>).find((r) => r.state === "CHANGES_REQUESTED");
      login = cr?.who ?? (JSON.parse(t.requested_reviewers || "[]") as string[])[0] ?? "";
    }
    if (!login) return { error: "couldn't identify the colleague to notify" };
    let name = login;
    try { name = JSON.parse(await ghText(["api", `users/${login}`, "--jq", "{name}"])).name || login; } catch { /* keep login */ }
    try {
      return await draftPing(kind, t.repo, t.number, login, name, req.body.gist ?? "");
    } catch {
      return { error: "couldn't draft the ping right now" };
    }
  });

  app.post<{ Body: { slackUserId?: string; message?: string } }>("/api/ping/send", async (req) => {
    if (!req.body.slackUserId || !req.body.message) return { error: "missing recipient or message" };
    try {
      await sendPing(req.body.slackUserId, req.body.message);
      return { ok: true };
    } catch (e) {
      return { error: String((e as Error).message).slice(0, 160) };
    }
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "no such job" });
    return job;
  });

  // Human-gated: posts a review verdict to GitHub. Only fires on explicit click.
  app.post<{ Params: { id: string }; Body: { verdict: string; body?: string } }>(
    "/api/jobs/:id/submit",
    async (req, reply) => {
      const job = getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "no such job" });
      await submitReview(job.repo, job.number, req.body.verdict, req.body.body ?? "");
      return { ok: true };
    },
  );

  await app.listen({ port, host: "127.0.0.1" });
  console.log(`dontpanic → http://127.0.0.1:${port}/now`);

  // Warm the isolated clones in the background so the first fix run isn't slow (free — no tokens).
  for (const r of loadConfig().repos) void warmClone(r).catch(() => {});

  // Actively look for new PRs / review requests: re-sync on a schedule (free — GitHub only).
  // Token-spending work (triage, context, agents) is NEVER run automatically — the user decides.
  setInterval(() => {
    if (syncing) return; // a manual resync is in flight
    syncing = true;
    runSync().catch(() => {}).finally(() => { syncing = false; });
  }, 10 * 60 * 1000);
}
