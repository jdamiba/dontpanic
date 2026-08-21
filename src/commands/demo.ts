// Demo mode: serve the real dashboard pages backed by canned, public-safe fixtures —
// no gh, no claude, no token spend. Used to capture UI screenshots for docs.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

// ---- synthetic, public-safe data (neutral repos/names/titles) ----
const pr = (o: Record<string, unknown>) => ({
  repo: `acme/${o.shortRepo}`,
  shortRepo: o.shortRepo,
  number: o.number,
  title: o.title,
  url: `https://github.com/acme/${o.shortRepo}/pull/${o.number}`,
  author: o.author ?? "octocat",
  turn: o.turn,
  ci: o.ci ?? "passing",
  mergeable: o.mergeable ?? "MERGEABLE",
  reviewDecision: o.reviewDecision ?? "",
  reviewers: o.reviewers ?? [],
  updatedAt: o.updatedAt ?? "2026-08-18T10:00:00Z",
});

const MINE = [
  pr({ shortRepo: "api", number: 903, title: "Fix cache invalidation on profile update", turn: "mine_fix", ci: "failing", mergeable: "CONFLICTING", reviewDecision: "REVIEW_REQUIRED" }),
  pr({ shortRepo: "web", number: 112, title: "Debounce autosave to cut redundant writes", turn: "mine_respond", ci: "passing", reviewDecision: "CHANGES_REQUESTED" }),
  pr({ shortRepo: "api", number: 870, title: "Bump dependencies + regenerate lockfile", turn: "ready_merge", ci: "passing", reviewDecision: "APPROVED" }),
  pr({ shortRepo: "web", number: 131, title: "Add keyboard nav to the command palette", turn: "mine_request_review" }),
  pr({ shortRepo: "api", number: 812, title: "Retry transient 5xx from the payments provider", turn: "theirs_review", reviewers: ["alexk"] }),
];
const REVIEW = [
  pr({ shortRepo: "api", number: 941, title: "Rate-limit the public search endpoint", turn: "mine_review", author: "priyanair", ci: "passing", reviewDecision: "CHANGES_REQUESTED" }),
  pr({ shortRepo: "web", number: 128, title: "Add an empty-state to the results table", turn: "mine_review", author: "jlee", ci: "passing" }),
  pr({ shortRepo: "web", number: 130, title: "Skeleton loaders for the dashboard cards", turn: "theirs_author", author: "octocat" }),
];

const EST = {
  prioritize: { usd: 0.5, tokens: 35000, n: 0, learned: false },
  enrich: { usd: 0.7, tokens: 45000, n: 0, learned: false },
  review: { usd: 1.0, tokens: 70000, n: 3, learned: true },
  fix: { usd: 2.0, tokens: 120000, n: 1, learned: true },
  meeting: { usd: 0.2, tokens: 15000, n: 0, learned: false },
  ping: { usd: 0.15, tokens: 10000, n: 0, learned: false },
  brief: { usd: 0.15, tokens: 40000, n: 4, learned: true },
};

const STATUS = {
  today: 2.1, session: 2.1, todayTokens: 480000, sessionTokens: 480000,
  limitUsd: 15, limitTokens: 2000000, est: EST, autoSpend: false, defaultAgent: "claude",
  lastSyncAt: 1786000000000, codex: true,
  turnOrder: ["mine_review", "mine_respond", "ready_merge", "mine_fix", "mine_request_review"],
  coaching: true,
};

const PLAN = {
  date: "Tuesday, Aug 18", meetingCount: 1, calendar: true, focusMins: 120, deferred: 2, courtZero: "11:40a",
  day: [
    { type: "task", shortRepo: "api", number: 941, title: REVIEW[0].title, kind: "Review", mins: 20, start: "9:00a" },
    { type: "meeting", id: "m1", start: "9:30a", title: "AI Pod Standup", kind: "standup", mins: 30 },
    { type: "task", shortRepo: "web", number: 128, title: REVIEW[1].title, kind: "Review", mins: 20, start: "10:00a" },
    { type: "task", shortRepo: "api", number: 870, title: MINE[2].title, kind: "Merge", mins: 10, start: "10:20a" },
    { type: "task", shortRepo: "api", number: 903, title: MINE[0].title, kind: "Fix CI", mins: 20, start: "10:30a" },
    { type: "task", shortRepo: "web", number: 112, title: MINE[1].title, kind: "Respond", mins: 15, start: "10:50a" },
  ],
};

const CONTEXT = {
  changeType: "backend",
  prompt: "# Review acme/api#941 — Rate-limit the public search endpoint\n\n[The PR's full unified diff is spliced in here when the agent runs.]",
  sources: [
    { name: "GitHub", connected: true, summary: "6-file diff (+184/−12); 3 review threads, 1 unresolved — e.g. “Use a sliding window, not fixed buckets, so a burst at the boundary can't double the limit.” CI passing." },
    { name: "Linear", connected: true, summary: "Linked ENG-742 — acceptance criteria to check against." },
    { name: "Slack", connected: false, summary: "Gather full context to surface the relevant discussion + the customer/incident 'why'." },
    { name: "Logfire", connected: false, summary: "Not connected yet — will surface prod health for the touched paths." },
    { name: "Braintrust", connected: false, summary: "No LLM / prompt change detected — nothing to pull." },
  ],
};

const ENRICH = {
  slack: "In #incidents, a customer hit 429s during a traffic spike last week — this endpoint was the culprit, so the limiter needs to be burst-tolerant.",
  slackUrl: "https://example.slack.com/archives/C123/p123",
  linear: "ENG-742: Add rate limiting to public search (High priority)",
  linearUrl: "https://linear.app/acme/issue/ENG-742",
  acceptance: "A single client cannot exceed 60 req/min, and a burst at a window boundary must not allow 2× the limit.",
  explainer:
    "src/search/handler.py is the single entry point for the public /search API — every unauthenticated query lands here. Today it has no rate limiting, so one noisy client can saturate the backend (the #incidents thread traces last week's 429 storm to exactly this path).\n\nThis PR adds a token-bucket limiter keyed by client IP, wired in as middleware before the handler. The bucket refills continuously rather than in fixed windows, which is the crux of the one unresolved review thread: fixed windows let a client fire a full burst at the end of one window and the start of the next, doubling the effective rate.\n\nThe deliverable is the limiter module, the middleware wiring, config for the per-client rate, and tests covering the boundary-burst case.",
  gaps: [
    { gap: "No load-test evidence that the limiter holds under the incident's traffic shape.", action: "Ask the author in #eng to attach a k6 run at ~2× the incident's peak RPS." },
  ],
  coach: {
    concept: "Token bucket vs fixed-window rate limiting",
    note: "A token bucket refills at a steady rate and allows short bursts up to the bucket size, while smoothing the sustained rate — unlike fixed windows, which permit a 2× burst across a boundary. That boundary-burst is exactly what the unresolved thread is guarding against.",
  },
};

const PRIORITY = {
  topKey: "api#941",
  topReason: "It's a customer-facing rate-limit fix tied to a real incident (429s during a traffic spike) — closing your review unblocks a High-priority Linear issue.",
  ranked: [
    { key: "api#941", impact: "high", reason: "Customer-facing; fixes a real incident (429 storm)." },
    { key: "web#128", impact: "med", reason: "UX polish on a high-traffic table; no urgency." },
    { key: "api#870", impact: "low", reason: "Dependency bump — approved & green, just merge." },
    { key: "api#903", impact: "high", reason: "Your CI is red on a cache-correctness bug." },
    { key: "web#112", impact: "med", reason: "Reviewer asked for a debounce tweak." },
  ],
};

const BRIEFS: Record<string, { state: string; suggestions: string[] }> = {
  "api#941": {
    state: "Adds a token-bucket rate limiter to the public search endpoint; CI is green, 1 unresolved review thread about boundary bursts. It's your turn to review.",
    suggestions: [
      "Confirm the bucket refills continuously (not fixed windows) so a boundary burst can't double the limit — that's the open thread.",
      "Check the limiter is keyed per-client and that the 60 req/min acceptance criterion is actually enforced in a test.",
      "Verify there's coverage for the burst-at-boundary case, not just the happy path.",
    ],
  },
  "web#128": {
    state: "Adds an empty-state to the results table. Green, no unresolved threads — a quick, low-risk review.",
    suggestions: ["Spin up the branch and check the empty-state renders for zero results and for a filtered-to-zero result set.", "Confirm the touched component's story covers the new state."],
  },
  "api#870": {
    state: "Routine dependency bump + lockfile regen. Approved and green — ready to merge.",
    suggestions: ["Skim the lockfile diff for any unexpected major-version jumps, then merge."],
  },
};

const REVIEW_JOB = {
  id: "job1_941", repo: "acme/api", number: 941, kind: "review", status: "done", backend: "claude",
  steps: ["Assembling diff + context… (claude)", "Read diff (196 lines) + gathered context. Reviewing…", "✓ Review ready."],
  segments: [
    { kind: "reasoning", text: "Let me check how the limiter tracks time.\nThe bucket refills based on elapsed wall-clock, which is good — that's continuous, not fixed windows. But I want to confirm the boundary case the reviewer flagged." },
    { kind: "tool", text: "Grep" },
    { kind: "reasoning", text: "The test file covers a steady-rate case and a single-burst case, but I don't see a test that fires a burst straddling two windows. That's the exact scenario from the incident, so it should be covered." },
    { kind: "text", text: '{"verdict":"request_changes","summary":"Solid token-bucket implementation, but the boundary-burst case the reviewer raised isn\'t tested.","findings":[...]}' },
  ],
  result: {
    verdict: "request_changes",
    summary: "Solid token-bucket implementation that matches the incident's need, but the boundary-burst case the open thread raises has no test — add one before merging.",
    findings: [
      { point: "No test fires a burst straddling two refill intervals — the exact 2× scenario from the incident.", file: "tests/test_ratelimit.py", line: 88 },
      { point: "The per-client key uses the raw IP; behind a proxy this collapses all clients to one. Confirm X-Forwarded-For handling.", file: "src/search/limiter.py", line: 34 },
    ],
  },
  costUsd: 0.91, tokens: 68400, durationMs: 41000,
};

const FIX_JOB = {
  id: "fix1_903", repo: "acme/api", number: 903, branch: "fix/cache-invalidation", status: "proposed", backend: "codex",
  steps: ["Preparing isolated clone… (codex)", "Cloned (isolated, partial).", "Checking out PR #903 in the isolated clone…", "✓ Proposed a diff — review it, then push when you're happy."],
  segments: [
    { kind: "reasoning", text: "The failing test expects the profile cache to be evicted on update, but the update path only writes the DB. I need to invalidate the cache key after the write commits." },
    { kind: "tool", text: "Edit" },
    { kind: "reasoning", text: "Added an explicit cache.delete(profile_key) after the transaction commits, and a test asserting a stale read can't happen." },
  ],
  diffStat: "2 files changed, 18 insertions(+), 3 deletions(-)",
  diff: "diff --git a/src/profile/service.py b/src/profile/service.py\n@@ -41,6 +41,9 @@ def update_profile(uid, data):\n     with db.transaction():\n         db.profiles.update(uid, data)\n+    # Invalidate the cache AFTER the write commits, or a concurrent read repopulates stale data.\n+    cache.delete(profile_key(uid))\n     return db.profiles.get(uid)\n",
  costUsd: null, tokens: 51200,
};

/** Start a demo dashboard: real pages, canned fixtures, no external calls. */
export async function startDemoDashboard(port: number, pubDir: string): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: pubDir, prefix: "/" });
  app.get("/now", (_req, reply) => reply.sendFile("now.html"));
  app.get("/parallel", (_req, reply) => reply.sendFile("parallel.html"));

  app.get("/api/status", async () => STATUS);
  app.get("/api/prs", async () => ({ me: "octocat", mine: MINE, review: REVIEW }));
  app.get("/api/plan", async () => PLAN);
  app.post("/api/priority", async () => PRIORITY);
  app.get("/api/briefs", async () => ({ briefs: BRIEFS }));
  app.post("/api/briefs", async () => ({ briefs: BRIEFS }));
  app.get("/api/now", async () => ({ task: { ...REVIEW[0], turn: "mine_review" }, context: CONTEXT }));
  app.get("/api/now/prompt", async () => ({ prompt: CONTEXT.prompt, gathered: true }));
  app.post("/api/now/enrich", async () => ENRICH);
  app.post("/api/now/launch", async () => ({ jobId: REVIEW_JOB.id }));
  app.post("/api/now/fix", async () => ({ jobId: FIX_JOB.id }));
  app.get("/api/jobs/:id", async () => REVIEW_JOB);
  app.get("/api/fix/:id", async () => FIX_JOB);
  app.get<{ Querystring: { id?: string } }>("/api/meeting", async () => ({
    title: "AI Pod Standup", kind: "standup", when: "9:30–10:00 AM", attendees: ["you", "teammate-a", "teammate-b"],
    prep: "Shipped: api#870 (deps). In review: api#812. Today: fix api#903 (cache), review api#941 (rate limit).",
    conferenceUrl: "", htmlLink: "",
  }));

  await app.listen({ port, host: "127.0.0.1" });
  console.log(`dontpanic (DEMO — canned data, no external calls) → http://127.0.0.1:${port}/`);
}
