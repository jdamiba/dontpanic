import Database from "better-sqlite3";
import { DB_PATH, ensureDir } from "./config.js";
import type { PrRow, Repo, Role } from "./types.js";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  ensureDir();
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS pr (
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      role TEXT NOT NULL,
      title TEXT,
      url TEXT,
      author TEXT,
      is_draft INTEGER,
      turn TEXT,
      ci_status TEXT,
      mergeable_state TEXT,
      review_decision TEXT,
      requested_reviewers TEXT,
      latest_reviews TEXT,
      last_commit_at TEXT,
      unresolved_threads INTEGER,
      base_branch TEXT,
      head_branch TEXT,
      last_action TEXT,
      last_action_at TEXT,
      gh_updated_at TEXT,
      synced_at TEXT,
      PRIMARY KEY (repo, number, role)
    );

    CREATE TABLE IF NOT EXISTS review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT, number INTEGER, kind TEXT,
      verdict TEXT, context_confidence REAL,
      research_json TEXT, summary TEXT, human_ask TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS job (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT, number INTEGER, kind TEXT, status TEXT,
      diff_ref TEXT, log_ref TEXT, created_at TEXT, updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS people (
      github_login TEXT PRIMARY KEY,
      display_name TEXT, slack_id TEXT, verified INTEGER, source TEXT
    );
  `);
}

export function upsertPr(row: PrRow, syncedAt: string): void {
  db()
    .prepare(
      `INSERT INTO pr (repo, number, role, title, url, author, is_draft, turn,
        ci_status, mergeable_state, review_decision, requested_reviewers,
        latest_reviews, last_commit_at, unresolved_threads, base_branch,
        head_branch, gh_updated_at, synced_at)
       VALUES (@repo, @number, @role, @title, @url, @author, @is_draft, @turn,
        @ci_status, @mergeable_state, @review_decision, @requested_reviewers,
        @latest_reviews, @last_commit_at, @unresolved_threads, @base_branch,
        @head_branch, @gh_updated_at, @synced_at)
       ON CONFLICT(repo, number, role) DO UPDATE SET
        title=excluded.title, url=excluded.url, author=excluded.author,
        is_draft=excluded.is_draft, turn=excluded.turn, ci_status=excluded.ci_status,
        mergeable_state=excluded.mergeable_state, review_decision=excluded.review_decision,
        requested_reviewers=excluded.requested_reviewers, latest_reviews=excluded.latest_reviews,
        last_commit_at=excluded.last_commit_at, unresolved_threads=excluded.unresolved_threads,
        base_branch=excluded.base_branch, head_branch=excluded.head_branch,
        gh_updated_at=excluded.gh_updated_at, synced_at=excluded.synced_at`,
    )
    .run({
      repo: row.repo,
      number: row.number,
      role: row.role,
      title: row.title,
      url: row.url,
      author: row.author,
      is_draft: row.isDraft ? 1 : 0,
      turn: row.turn,
      ci_status: row.ciStatus,
      mergeable_state: row.mergeable,
      review_decision: row.reviewDecision,
      requested_reviewers: JSON.stringify(row.requestedReviewers),
      latest_reviews: JSON.stringify(row.latestReviews),
      last_commit_at: row.lastCommitAt,
      unresolved_threads: row.unresolvedThreads ?? null,
      base_branch: row.baseBranch,
      head_branch: row.headBranch,
      gh_updated_at: row.updatedAt,
      synced_at: syncedAt,
    });
}

/** Replace all rows for a (repo, role) pair atomically — drops closed/merged PRs. */
export function replaceRepoRole(repo: Repo, role: Role, rows: PrRow[], syncedAt: string): void {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM pr WHERE repo = ? AND role = ?`).run(repo, role);
    for (const r of rows) upsertPr(r, syncedAt);
  });
  tx();
}

export interface StoredPr {
  repo: string;
  number: number;
  role: Role;
  title: string;
  url: string;
  author: string;
  is_draft: number;
  turn: string;
  ci_status: string;
  mergeable_state: string;
  review_decision: string;
  requested_reviewers: string; // JSON
  latest_reviews: string; // JSON
  last_commit_at: string | null;
  unresolved_threads: number | null;
  gh_updated_at: string;
}

export function allPrs(role?: Role): StoredPr[] {
  const d = db();
  return role
    ? (d.prepare(`SELECT * FROM pr WHERE role = ? ORDER BY repo, number`).all(role) as StoredPr[])
    : (d.prepare(`SELECT * FROM pr ORDER BY repo, number`).all() as StoredPr[]);
}
