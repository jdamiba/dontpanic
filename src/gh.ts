import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CiStatus, MergeableState, RawPr, ReviewDecision, ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);

// NOTE: `commits` is deliberately excluded — its nested author connection makes
// the bulk GraphQL query exceed the node budget at high --limit. We fetch the
// last-commit timestamp per-PR (fetchLastCommitAt) only for the small subset of
// PRs whose turn actually depends on it.
const PR_FIELDS = [
  "number",
  "title",
  "url",
  "isDraft",
  "mergeable",
  "reviewDecision",
  "reviewRequests",
  "latestReviews",
  "statusCheckRollup",
  "headRefName",
  "baseRefName",
  "updatedAt",
  "author",
].join(",");

// GitHub returns transient 5xx / rate-limit / timeout errors under load; these reads are
// idempotent, so retry them a few times with backoff before giving up.
const TRANSIENT = /HTTP 5\d\d|\b50[234]\b|No server is currently|submitted too quickly|rate limit|timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i;

async function gh(args: string[], attempt = 0): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const msg = String((e as { stderr?: string; message?: string }).stderr || (e as Error).message || "");
    if (attempt < 3 && TRANSIENT.test(msg)) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); // 400 / 800 / 1600 ms
      return gh(args, attempt + 1);
    }
    throw e;
  }
}

/** Public wrapper so other modules can shell gh for ad-hoc reads. */
export function ghText(args: string[]): Promise<string> {
  return gh(args);
}

/** Reduce gh's statusCheckRollup array to a single CI status. */
function ciFromRollup(rollup: unknown): CiStatus {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let sawPending = false;
  let sawSuccess = false;
  for (const c of rollup as Array<Record<string, string>>) {
    // CheckRun: {status, conclusion}; StatusContext: {state}
    const conclusion = (c.conclusion || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    const state = (c.state || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion))
      return "failing";
    if (state === "FAILURE" || state === "ERROR") return "failing";
    if ((status && status !== "COMPLETED") || state === "PENDING" || state === "EXPECTED")
      sawPending = true;
    if (conclusion === "SUCCESS" || state === "SUCCESS") sawSuccess = true;
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "passing";
  return "none"; // e.g. all skipped/neutral
}

interface RawGhPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  reviewRequests?: Array<{ login?: string; name?: string }>;
  latestReviews?: Array<{ author?: { login?: string }; state: string; submittedAt: string | null }>;
  statusCheckRollup?: unknown;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  author?: { login?: string };
}

function normalize(repo: string, p: RawGhPr): RawPr {
  return {
    repo,
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author?.login ?? "",
    isDraft: p.isDraft,
    mergeable: (p.mergeable || "UNKNOWN") as MergeableState,
    reviewDecision: (p.reviewDecision || "") as ReviewDecision,
    requestedReviewers: (p.reviewRequests ?? [])
      .map((r) => r.login ?? r.name ?? "")
      .filter(Boolean),
    latestReviews: (p.latestReviews ?? []).map((r) => ({
      who: r.author?.login ?? "",
      state: r.state as ReviewState,
      at: r.submittedAt,
    })),
    lastCommitAt: null, // enriched on demand via fetchLastCommitAt
    ciStatus: ciFromRollup(p.statusCheckRollup),
    baseBranch: p.baseRefName,
    headBranch: p.headRefName,
    updatedAt: p.updatedAt,
  };
}

/** PRs I authored, open, in one repo. */
export async function fetchAuthored(repo: string): Promise<RawPr[]> {
  const out = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--author",
    "@me",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    PR_FIELDS,
  ]);
  return (JSON.parse(out) as RawGhPr[]).map((p) => normalize(repo, p));
}

/** PRs where I'm requested as reviewer, open, in one repo. */
export async function fetchReviewRequested(repo: string): Promise<RawPr[]> {
  const out = await gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--search",
    "review-requested:@me",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    PR_FIELDS,
  ]);
  return (JSON.parse(out) as RawGhPr[]).map((p) => normalize(repo, p));
}

/** Most-recent commit date for a single PR (cheap: commits connection for one node). */
export async function fetchLastCommitAt(repo: string, number: number): Promise<string | null> {
  const out = await gh([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "commits",
  ]);
  const commits = (JSON.parse(out).commits ?? []) as Array<{ committedDate?: string }>;
  return commits.length ? (commits[commits.length - 1].committedDate ?? null) : null;
}
