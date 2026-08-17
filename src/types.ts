// Core domain types.

export type Repo = string; // "owner/name", e.g. "vercel/next.js"
export type Role = "author" | "reviewer";

// Ball-in-court state for a PR I authored.
export type AuthorTurn =
  | "draft" // WIP, excluded from action lists
  | "mine_fix" // my turn — CI failing or merge conflict (mechanical)
  | "mine_respond" // my turn — address requested changes / unresolved threads
  | "mine_request_review" // my turn — no reviewer assigned yet
  | "theirs_review" // waiting on a reviewer
  | "ready_merge"; // my turn — approved, green, mergeable

// Ball-in-court state for a PR I'm assigned to review.
export type ReviewerTurn =
  | "mine_review" // my turn — first review or re-review after their push
  | "theirs_author" // waiting on the author to address my changes
  | "done"; // I approved; nothing for me

export type Turn = AuthorTurn | ReviewerTurn;

export type CiStatus = "passing" | "failing" | "pending" | "none";

// GitHub review states we care about.
export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

// GitHub's aggregate reviewDecision (empty string when undecided / draft).
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";

export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface ReviewSummary {
  who: string; // reviewer login
  state: ReviewState;
  at: string | null; // ISO submittedAt
}

// Normalized PR shape independent of any single gh query.
export interface RawPr {
  repo: Repo;
  number: number;
  title: string;
  url: string;
  author: string; // login
  isDraft: boolean;
  mergeable: MergeableState;
  reviewDecision: ReviewDecision;
  requestedReviewers: string[]; // logins (team names normalized out where possible)
  latestReviews: ReviewSummary[]; // gh `latestReviews`: latest per reviewer
  lastCommitAt: string | null; // ISO of most recent commit (push proxy)
  ciStatus: CiStatus;
  baseBranch: string;
  headBranch: string;
  updatedAt: string; // ISO gh updatedAt
  unresolvedThreads?: number | null; // optional GraphQL refinement
}

// A row as persisted, with role + computed turn.
export interface PrRow extends RawPr {
  role: Role;
  turn: Turn;
}
