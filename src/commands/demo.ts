// Demo mode: serve the real dashboard pages backed by canned, public-safe fixtures —
// no gh, no claude, no token spend. Used to try the UI and capture screenshots.
// The scenario is deliberately BEGINNER-FRIENDLY: you're building a small recipe app
// ("Cookbook") with a friend (Sam), so the tasks, context, and coaching are approachable
// to someone new to building — not senior-backend jargon.
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const pr = (o: Record<string, unknown>) => ({
  repo: "you/cookbook",
  shortRepo: "cookbook",
  number: o.number,
  title: o.title,
  url: `https://github.com/you/cookbook/pull/${o.number}`,
  author: o.author ?? "you",
  turn: o.turn,
  ci: o.ci ?? "passing",
  mergeable: o.mergeable ?? "MERGEABLE",
  reviewDecision: o.reviewDecision ?? "",
  reviewers: o.reviewers ?? [],
  updatedAt: o.updatedAt ?? "2026-08-18T10:00:00Z",
});

const MINE = [
  pr({ number: 7, title: "Fix: new recipes show a cooking time of 0", turn: "mine_fix", ci: "failing", reviewDecision: "REVIEW_REQUIRED" }),
  pr({ number: 5, title: "Add a favorite ♥ button to recipes", turn: "mine_respond", ci: "passing", reviewDecision: "CHANGES_REQUESTED" }),
  pr({ number: 8, title: "Add a friendly welcome screen for your first recipe", turn: "ready_merge", ci: "passing", reviewDecision: "APPROVED" }),
  pr({ number: 9, title: "Search your recipes by ingredient", turn: "mine_request_review" }),
  pr({ number: 4, title: "Add a photo to each recipe", turn: "theirs_review", reviewers: ["sam"] }),
];
const REVIEW = [
  pr({ number: 6, title: "Sort recipes newest-first", turn: "mine_review", author: "sam" }),
  pr({ number: 3, title: "Add a Print button to a recipe", turn: "mine_review", author: "sam" }),
  pr({ number: 10, title: "Add a dark-mode toggle", turn: "theirs_author", author: "sam" }),
];

const EST = {
  prioritize: { usd: 0.05, tokens: 12000, n: 0, learned: false },
  enrich: { usd: 0.07, tokens: 14000, n: 0, learned: false },
  review: { usd: 0.08, tokens: 9000, n: 3, learned: true },
  fix: { usd: 0.12, tokens: 14000, n: 1, learned: true },
  meeting: { usd: 0.05, tokens: 8000, n: 0, learned: false },
  ping: { usd: 0.03, tokens: 5000, n: 0, learned: false },
  brief: { usd: 0.04, tokens: 10000, n: 3, learned: true },
};

const STATUS = {
  today: 0.38, session: 0.38, todayTokens: 92000, sessionTokens: 92000,
  limitUsd: 15, limitTokens: 2000000, est: EST, autoSpend: false, defaultAgent: "claude",
  lastSyncAt: 1786000000000, codex: true,
  turnOrder: ["mine_review", "mine_respond", "ready_merge", "mine_fix", "mine_request_review"],
  coaching: true,
};

const PLAN = {
  date: "Tuesday, Aug 18", meetingCount: 1, calendar: true, focusMins: 95, deferred: 1, courtZero: "11:05a",
  day: [
    { type: "task", shortRepo: "cookbook", number: 7, title: MINE[0].title, kind: "Fix CI", mins: 20, start: "9:00a" },
    { type: "meeting", id: "m1", start: "9:30a", title: "Catch up with Sam", kind: "meeting", mins: 20 },
    { type: "task", shortRepo: "cookbook", number: 6, title: REVIEW[0].title, kind: "Review", mins: 15, start: "9:50a" },
    { type: "task", shortRepo: "cookbook", number: 8, title: MINE[2].title, kind: "Merge", mins: 10, start: "10:05a" },
    { type: "task", shortRepo: "cookbook", number: 5, title: MINE[1].title, kind: "Respond", mins: 15, start: "10:15a" },
    { type: "task", shortRepo: "cookbook", number: 9, title: MINE[3].title, kind: "Assign", mins: 10, start: "10:30a" },
  ],
};

// The Now page features your own bug fix (#7) — the most relatable "build with an agent" moment.
const CONTEXT = {
  changeType: "frontend",
  prompt: "# Fix the failing tests on you/cookbook#7 — new recipes show a cooking time of 0\n\n[The failing test output is included here when the agent runs.]",
  sources: [
    { name: "GitHub", connected: true, summary: "3-file change (+22/−4); 1 comment from Sam — “nice! does this handle when the cooking-time box is left blank?”. Tests are currently red." },
    { name: "Linear", connected: false, summary: "No linked issue — totally fine for a personal project." },
    { name: "Slack", connected: false, summary: "Gather full context to pull in what people said about this." },
  ],
};

const ENRICH = {
  slack: "A friend who tried the app messaged you: “I added a recipe and the cooking time shows 0 instead of the 30 minutes I typed.”",
  slackUrl: "https://example.com/chat/123",
  linear: "none found",
  linearUrl: "",
  acceptance: "A recipe should show the cooking time you actually entered — not 0.",
  explainer:
    "The recipe form (RecipeForm.js) saves whatever you type in the “cooking time” box. Right now it saves it as text — the characters “3” and “0” — not the number 30.\n\nLater, the recipe card tries to do a little math with the cooking time to show it nicely. Doing math on text gives “not a number”, which the app ends up showing as 0. That's the bug your friend hit.\n\nThe fix is to turn the text into a real number the moment it's saved. This is one of the most common surprises when you're new: the computer treats “30” (text) and 30 (a number) as completely different things.",
  gaps: [
    { gap: "It's not decided what should happen if the cooking-time box is left empty.", action: "Make a quick call (with Sam?) — default it to blank, or ask again? Jot the decision on the PR so future-you remembers." },
  ],
  coach: {
    concept: "Text vs. numbers",
    note: "Your form stored the cooking time as text (\"30\"), but the app tried to do math with it — and math on text gives \"NaN\", which showed up as 0. Converting it with Number(...) when you save is the fix. \"What type is this value — text or a number?\" is a question you'll ask constantly, and catching it early saves a lot of head-scratching.",
  },
};

const PRIORITY = {
  topKey: "cookbook#7",
  topReason: "It's a bug anyone sees the moment they add a recipe — the cooking time shows 0. Fixing it makes the whole app feel trustworthy, so it's the best place to start.",
  ranked: [
    { key: "cookbook#7", impact: "high", reason: "A visible bug on the main screen — everyone who adds a recipe hits it." },
    { key: "cookbook#6", impact: "med", reason: "Sam's sorting change — worth a look, but no rush." },
    { key: "cookbook#8", impact: "low", reason: "The welcome screen is done and approved — just merge it." },
    { key: "cookbook#5", impact: "med", reason: "Sam asked a question on your favorite-button PR." },
  ],
};

const BRIEFS: Record<string, { state: string; suggestions: string[] }> = {
  "cookbook#7": {
    state: "New recipes show a cooking time of 0 instead of what you typed, and the tests are red. It's your turn to fix it.",
    suggestions: [
      "Find where the form saves the cooking time — it's probably being stored as text, not a number.",
      "Convert it to a number when saving (e.g. Number(value)) so the recipe card can do math with it.",
      "Decide what should happen if the box is left blank, and note it on the PR.",
    ],
  },
  "cookbook#6": {
    state: "Sam's change sorts your recipes newest-first. Tests pass — a quick, friendly review.",
    suggestions: [
      "Check what happens to a recipe that doesn't have a date yet — does it sort somewhere sensible?",
      "Confirm “newest” means what you'd expect (when it was added, not last edited).",
    ],
  },
  "cookbook#8": {
    state: "A welcome screen for before you've saved any recipes. Done and approved — ready to merge.",
    suggestions: ["Give it one last look at phone size, then merge it."],
  },
};

// Reviewing Sam's PRs — a gentle, encouraging approve. One job per PR so each
// review card in the parallel grid reads about its own change (not a shared blurb).
const REVIEW_JOBS: Record<number, any> = {
  6: {
    id: "job1_6", repo: "you/cookbook", number: 6, kind: "review", status: "done", backend: "claude",
    steps: ["Assembling the change + context… (claude)", "Read the change (18 lines). Reviewing…", "✓ Review ready."],
    segments: [
      { kind: "reasoning", text: "Let me see how Sam's change sorts the recipes.\nIt orders them by the date each recipe was added, newest first — that matches what \"newest-first\" should mean." },
      { kind: "tool", text: "Read" },
      { kind: "reasoning", text: "One thing to check: a brand-new recipe that hasn't been saved has no date yet. It looks like those fall to the bottom rather than erroring, which is fine. The change is small and safe." },
      { kind: "text", text: '{"verdict":"approve","summary":"Clean, safe change — recipes now show newest-first...","findings":[...]}' },
    ],
    result: {
      verdict: "approve",
      summary: "Nice — recipes now show newest-first, and ones without a date still behave sensibly. Good to merge.",
      findings: [
        { point: "Optional idea: show the date on each recipe card so the order is obvious to anyone looking.", file: "RecipeCard.js", line: 12 },
      ],
    },
    costUsd: 0.08, tokens: 9200, durationMs: 16000,
  },
  3: {
    id: "job1_3", repo: "you/cookbook", number: 3, kind: "review", status: "done", backend: "claude",
    steps: ["Assembling the change + context… (claude)", "Read the change (14 lines). Reviewing…", "✓ Review ready."],
    segments: [
      { kind: "reasoning", text: "Sam added a \"Print\" button to a recipe. Let me check what it actually prints.\nIt opens the browser's print dialog showing just the recipe — not the site header or the other buttons." },
      { kind: "tool", text: "Read" },
      { kind: "reasoning", text: "It uses a print-only stylesheet, so the page still looks normal on screen and only the recipe ends up on paper. Small and safe." },
      { kind: "text", text: '{"verdict":"approve","summary":"Clean print view — just the recipe...","findings":[...]}' },
    ],
    result: {
      verdict: "approve",
      summary: "Prints cleanly — just the recipe, none of the site chrome. Good to merge.",
      findings: [
        { point: "Optional: add a little page margin so the title isn't right against the edge of the paper.", file: "RecipeView.js", line: 8 },
      ],
    },
    costUsd: 0.08, tokens: 8600, durationMs: 15000,
  },
};
const REVIEW_JOB = REVIEW_JOBS[6];
function reviewJobFor(task: string | undefined): any {
  const n = Number((task || "").split("#")[1]);
  return REVIEW_JOBS[n] || REVIEW_JOB;
}

// Fixing your own bug (#7) — a small, readable change you approve.
const FIX_JOB = {
  id: "fix1_7", repo: "you/cookbook", number: 7, branch: "fix/cooking-time", status: "proposed", backend: "claude",
  steps: ["Preparing a safe copy of your project… (claude)", "Made a copy (it won't touch your working folder).", "Checking out PR #7…", "✓ Proposed a change — read it, then apply it when you're happy."],
  segments: [
    { kind: "reasoning", text: "The failing test says a recipe saved with \"30\" shows 0. The form is storing the cooking time as text, and the recipe card does math with it — math on text gives NaN, shown as 0." },
    { kind: "tool", text: "Edit" },
    { kind: "reasoning", text: "I converted the value to a number when it's saved, and added a small test: adding \"30\" should show 30, not 0." },
  ],
  diffStat: "2 files changed, 9 insertions(+), 2 deletions(-)",
  diff: "diff --git a/src/RecipeForm.js b/src/RecipeForm.js\n@@ -18,7 +18,8 @@ function saveRecipe(form) {\n   const recipe = {\n     name: form.name,\n-    cookTime: form.cookTime,\n+    // Store the cooking time as a number so the recipe card can do math with it.\n+    cookTime: Number(form.cookTime) || 0,\n   };\n   return db.recipes.add(recipe);\n",
  costUsd: 0.12, tokens: 14200,
};

/** Start a demo dashboard: real pages, canned beginner-friendly fixtures, no external calls. */
export async function startDemoDashboard(port: number, pubDir: string): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: pubDir, prefix: "/" });
  app.get("/now", (_req, reply) => reply.sendFile("now.html"));
  app.get("/parallel", (_req, reply) => reply.sendFile("parallel.html"));

  app.get("/api/status", async () => STATUS);
  app.get("/api/prs", async () => ({ me: "you", mine: MINE, review: REVIEW }));
  app.get("/api/plan", async () => PLAN);
  app.post("/api/priority", async () => PRIORITY);
  app.get("/api/briefs", async () => ({ briefs: BRIEFS }));
  app.post("/api/briefs", async () => ({ briefs: BRIEFS }));
  app.get("/api/now", async () => ({ task: { ...MINE[0], turn: "mine_fix" }, context: CONTEXT }));
  app.get("/api/now/prompt", async () => ({ prompt: CONTEXT.prompt, gathered: true }));
  app.post("/api/now/enrich", async () => ENRICH);
  app.post<{ Querystring: { task?: string } }>("/api/now/launch", async (req) => ({ jobId: reviewJobFor(req.query.task).id }));
  app.post("/api/now/fix", async () => ({ jobId: FIX_JOB.id }));
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    const hit = Object.values(REVIEW_JOBS).find((j) => j.id === req.params.id);
    return hit || REVIEW_JOB;
  });
  app.get("/api/fix/:id", async () => FIX_JOB);
  app.get<{ Querystring: { id?: string } }>("/api/meeting", async () => ({
    title: "Catch up with Sam", kind: "meeting", when: "9:30–9:50 AM", attendees: ["you", "sam"],
    prep: "Quick check-in on the recipe app. Shipped: the welcome screen (#8). Today: fixing the cooking-time bug (#7). Ask Sam: what should a blank cooking time do?",
    conferenceUrl: "", htmlLink: "",
  }));

  await app.listen({ port, host: "127.0.0.1" });
  console.log(`dontpanic (DEMO — canned data, no external calls) → http://127.0.0.1:${port}/`);
}
