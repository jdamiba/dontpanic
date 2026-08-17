import { loadConfig } from "../config.js";
import { fetchAuthored, fetchReviewRequested, fetchLastCommitAt } from "../gh.js";
import { computeAuthorTurn, computeReviewerTurn } from "../turn.js";
import { replaceRepoRole } from "../db.js";
import type { PrRow, RawPr, Role } from "../types.js";

/**
 * lastCommitAt is only consulted by the turn logic in two cases, so we fetch it
 * (an extra per-PR call) only for those — keeping sync cheap.
 */
function needsCommitAt(role: Role, pr: RawPr, me: string): boolean {
  if (role === "author") return pr.reviewDecision === "CHANGES_REQUESTED";
  if (pr.requestedReviewers.includes(me)) return false;
  const mine = pr.latestReviews.find((r) => r.who === me);
  return !!mine && mine.state !== "APPROVED";
}

async function enrich(prs: RawPr[], role: Role, me: string): Promise<void> {
  const targets = prs.filter((p) => needsCommitAt(role, p, me));
  // Tolerate a single PR's fetch failing (leave lastCommitAt null → turn logic falls back)
  // rather than aborting the whole sync when GitHub is flaky.
  await Promise.all(
    targets.map(async (p) => {
      try { p.lastCommitAt = await fetchLastCommitAt(p.repo, p.number); } catch { /* keep null */ }
    }),
  );
}

// Sync one (repo, role) independently: fetch the OPEN PRs and atomically replace the
// stored rows for that pair — which drops any PR that's since been closed/merged. Isolated
// so one flaky fetch can't block the others (and can't leave a closed PR lingering).
async function syncRole(repo: string, role: Role, me: string, syncedAt: string): Promise<number> {
  const raw = role === "author" ? await fetchAuthored(repo) : await fetchReviewRequested(repo);
  await enrich(raw, role, me);
  const rows: PrRow[] = raw.map((p) => ({
    ...p,
    role,
    turn: role === "author" ? computeAuthorTurn(p) : computeReviewerTurn(p, me),
  }));
  replaceRepoRole(repo, role, rows, syncedAt);
  return rows.length;
}

export async function sync(): Promise<void> {
  const cfg = loadConfig();
  const syncedAt = new Date().toISOString();
  const roles: Role[] = ["author", "reviewer"];

  let ok = 0;
  const failures: string[] = [];
  for (const repo of cfg.repos) {
    for (const role of roles) {
      try {
        const n = await syncRole(repo, role, cfg.me, syncedAt);
        ok++;
        process.stdout.write(`${repo.split("/").pop()}/${role}: ${n}  `);
      } catch (e) {
        failures.push(`${repo}/${role}: ${String((e as Error).message).split("\n")[0].slice(0, 60)}`);
      }
    }
  }
  console.log("");
  // Partial success still updated what it could (dropping closed PRs there). Only fail the
  // whole sync if nothing updated, so the caller/UI can report a real outage.
  if (ok === 0 && failures.length) throw new Error("sync failed: " + failures.join("; "));
  if (failures.length) console.log(`  (partial: ${failures.length} list(s) failed — ${failures.join("; ")})`);
}
