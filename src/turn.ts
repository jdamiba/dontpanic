// The core "whose turn is it" (ball-in-court) state machines.
// Pure functions — no I/O — so they are exhaustively unit-testable.

import type { RawPr, AuthorTurn, ReviewerTurn } from "./types.js";

/** Latest CHANGES_REQUESTED review time across all reviewers, or null. */
function latestChangesRequestedAt(pr: RawPr): string | null {
  const times = pr.latestReviews
    .filter((r) => r.state === "CHANGES_REQUESTED" && r.at)
    .map((r) => r.at as string)
    .sort();
  return times.length ? times[times.length - 1] : null;
}

/** ISO-string comparison is chronologically correct for UTC `Z` timestamps. */
function isAfter(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a > b;
}

/**
 * Ball-in-court for a PR I authored. First matching rule wins, matching the
 * order in the plan's state table.
 */
export function computeAuthorTurn(pr: RawPr): AuthorTurn {
  if (pr.isDraft) return "draft";

  // Mechanical blockers are my turn regardless of review state.
  if (pr.ciStatus === "failing" || pr.mergeable === "CONFLICTING") return "mine_fix";

  const hasReviewer = pr.requestedReviewers.length > 0 || pr.latestReviews.length > 0;

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    const crAt = latestChangesRequestedAt(pr);
    // My turn if I have not pushed since the changes were requested.
    if (isAfter(pr.lastCommitAt, crAt)) return "theirs_review";
    return "mine_respond";
  }

  if (pr.reviewDecision === "APPROVED") {
    if (pr.mergeable !== "MERGEABLE") return "mine_fix";
    if ((pr.unresolvedThreads ?? 0) > 0) return "mine_respond";
    return "ready_merge";
  }

  // REVIEW_REQUIRED, or undecided ("") on a non-draft PR.
  return hasReviewer ? "theirs_review" : "mine_request_review";
}

/**
 * Ball-in-court for a PR I'm assigned to review. `me` is my GitHub login.
 */
export function computeReviewerTurn(pr: RawPr, me: string): ReviewerTurn {
  // An active review request (including a re-request after I already reviewed)
  // always means it's my turn.
  if (pr.requestedReviewers.includes(me)) return "mine_review";

  // gh `latestReviews` holds the latest review per reviewer, so at most one is mine.
  const mine = pr.latestReviews.find((r) => r.who === me) ?? null;
  if (!mine) return "mine_review"; // assigned but no review from me yet

  if (mine.state === "APPROVED") return "done";

  // CHANGES_REQUESTED or COMMENTED: my turn again only if they pushed since.
  if (isAfter(pr.lastCommitAt, mine.at)) return "mine_review";
  return "theirs_author";
}

// Display/sort ordering: action-needed first.
export const AUTHOR_TURN_ORDER: AuthorTurn[] = [
  "mine_fix",
  "mine_respond",
  "mine_request_review",
  "ready_merge",
  "theirs_review",
  "draft",
];

export const REVIEWER_TURN_ORDER: ReviewerTurn[] = ["mine_review", "theirs_author", "done"];

/** True when the ball is in my court (an action list should surface it). */
export function isMyTurn(turn: AuthorTurn | ReviewerTurn): boolean {
  return turn.startsWith("mine_") || turn === "ready_merge";
}
