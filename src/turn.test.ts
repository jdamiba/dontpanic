import { describe, it, expect } from "vitest";
import { computeAuthorTurn, computeReviewerTurn } from "./turn.js";
import type { RawPr, ReviewSummary } from "./types.js";

const T0 = "2026-08-01T10:00:00Z"; // earlier
const T1 = "2026-08-01T12:00:00Z"; // later

function pr(overrides: Partial<RawPr> = {}): RawPr {
  return {
    repo: "acme/webapp",
    number: 1,
    title: "test",
    url: "https://github.com/x/y/pull/1",
    author: "jdamiba",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    requestedReviewers: [],
    latestReviews: [],
    lastCommitAt: T0,
    ciStatus: "passing",
    baseBranch: "develop",
    headBranch: "feature",
    updatedAt: T1,
    unresolvedThreads: null,
    ...overrides,
  };
}

const review = (who: string, state: ReviewSummary["state"], at: string | null): ReviewSummary => ({
  who,
  state,
  at,
});

describe("computeAuthorTurn", () => {
  it("draft is draft regardless of other state", () => {
    expect(computeAuthorTurn(pr({ isDraft: true, mergeable: "CONFLICTING" }))).toBe("draft");
  });

  it("failing CI -> mine_fix (even if approved)", () => {
    expect(computeAuthorTurn(pr({ ciStatus: "failing", reviewDecision: "APPROVED" }))).toBe(
      "mine_fix",
    );
  });

  it("merge conflict -> mine_fix", () => {
    expect(computeAuthorTurn(pr({ mergeable: "CONFLICTING" }))).toBe("mine_fix");
  });

  it("changes requested, no push since -> mine_respond", () => {
    expect(
      computeAuthorTurn(
        pr({
          reviewDecision: "CHANGES_REQUESTED",
          latestReviews: [review("octocat", "CHANGES_REQUESTED", T1)],
          lastCommitAt: T0, // pushed before the review
        }),
      ),
    ).toBe("mine_respond");
  });

  it("changes requested, pushed since -> theirs_review", () => {
    expect(
      computeAuthorTurn(
        pr({
          reviewDecision: "CHANGES_REQUESTED",
          latestReviews: [review("octocat", "CHANGES_REQUESTED", T0)],
          lastCommitAt: T1, // pushed after the review
        }),
      ),
    ).toBe("theirs_review");
  });

  it("no reviewer, no reviews -> mine_request_review", () => {
    expect(computeAuthorTurn(pr({ reviewDecision: "REVIEW_REQUIRED", requestedReviewers: [] }))).toBe(
      "mine_request_review",
    );
  });

  it("empty decision, no reviewer -> mine_request_review", () => {
    expect(computeAuthorTurn(pr({ reviewDecision: "" }))).toBe("mine_request_review");
  });

  it("reviewer assigned, awaiting first review -> theirs_review", () => {
    expect(
      computeAuthorTurn(pr({ reviewDecision: "REVIEW_REQUIRED", requestedReviewers: ["octocat"] })),
    ).toBe("theirs_review");
  });

  it("approved + green + mergeable + no threads -> ready_merge", () => {
    expect(
      computeAuthorTurn(
        pr({ reviewDecision: "APPROVED", latestReviews: [review("octocat", "APPROVED", T1)] }),
      ),
    ).toBe("ready_merge");
  });

  it("approved but conflicting -> mine_fix", () => {
    expect(computeAuthorTurn(pr({ reviewDecision: "APPROVED", mergeable: "CONFLICTING" }))).toBe(
      "mine_fix",
    );
  });

  it("approved + green but unresolved threads -> mine_respond", () => {
    expect(
      computeAuthorTurn(pr({ reviewDecision: "APPROVED", unresolvedThreads: 2 })),
    ).toBe("mine_respond");
  });
});

describe("computeReviewerTurn", () => {
  const me = "jdamiba";

  it("actively requested -> mine_review", () => {
    expect(computeReviewerTurn(pr({ requestedReviewers: [me] }), me)).toBe("mine_review");
  });

  it("requested even after an earlier approval (re-request) -> mine_review", () => {
    expect(
      computeReviewerTurn(
        pr({ requestedReviewers: [me], latestReviews: [review(me, "APPROVED", T0)] }),
        me,
      ),
    ).toBe("mine_review");
  });

  it("assigned but no review yet -> mine_review", () => {
    expect(computeReviewerTurn(pr({ requestedReviewers: [], latestReviews: [] }), me)).toBe(
      "mine_review",
    );
  });

  it("I approved -> done", () => {
    expect(
      computeReviewerTurn(pr({ latestReviews: [review(me, "APPROVED", T1)] }), me),
    ).toBe("done");
  });

  it("I requested changes, no push since -> theirs_author", () => {
    expect(
      computeReviewerTurn(
        pr({ latestReviews: [review(me, "CHANGES_REQUESTED", T1)], lastCommitAt: T0 }),
        me,
      ),
    ).toBe("theirs_author");
  });

  it("I requested changes, author pushed since -> mine_review", () => {
    expect(
      computeReviewerTurn(
        pr({ latestReviews: [review(me, "CHANGES_REQUESTED", T0)], lastCommitAt: T1 }),
        me,
      ),
    ).toBe("mine_review");
  });

  it("I only commented, author pushed since -> mine_review", () => {
    expect(
      computeReviewerTurn(
        pr({ latestReviews: [review(me, "COMMENTED", T0)], lastCommitAt: T1 }),
        me,
      ),
    ).toBe("mine_review");
  });

  it("ignores other reviewers' reviews when deciding my turn", () => {
    expect(
      computeReviewerTurn(
        pr({ latestReviews: [review("someoneelse", "APPROVED", T1)] }),
        me,
      ),
    ).toBe("mine_review");
  });
});
