import { describe, it, expect } from "vitest";
import { pickOneTask, rankTasks, isActionable, scheduleDay, FOCUS_CAP } from "./planner.js";
import type { StoredPr } from "./db.js";
import type { Meeting } from "./broker.js";

function row(overrides: Partial<StoredPr> = {}): StoredPr {
  return {
    repo: "acme/webapp",
    number: 1,
    role: "author",
    title: "t",
    url: "u",
    author: "jdamiba",
    is_draft: 0,
    turn: "mine_fix",
    ci_status: "failing",
    mergeable_state: "MERGEABLE",
    review_decision: "",
    requested_reviewers: "[]",
    latest_reviews: "[]",
    last_commit_at: null,
    unresolved_threads: null,
    gh_updated_at: "2026-08-01T12:00:00Z",
    ...overrides,
  };
}

describe("planner", () => {
  it("ignores non-actionable turns (theirs_review, draft, done)", () => {
    expect(isActionable(row({ turn: "theirs_review" }))).toBe(false);
    expect(isActionable(row({ turn: "draft" }))).toBe(false);
    expect(isActionable(row({ turn: "done" }))).toBe(false);
    expect(isActionable(row({ turn: "mine_review" }))).toBe(true);
  });

  it("prioritizes responsibilities-to-others (mine_review) over own work (mine_fix)", () => {
    const rows = [
      row({ number: 1, turn: "mine_fix" }),
      row({ number: 2, turn: "mine_review", role: "reviewer" }),
      row({ number: 3, turn: "ready_merge" }),
    ];
    expect(pickOneTask(rows)?.number).toBe(2);
    expect(rankTasks(rows).map((r) => r.number)).toEqual([2, 3, 1]);
  });

  it("breaks ties within a turn by staleness (older gh_updated_at first)", () => {
    const rows = [
      row({ number: 1, turn: "mine_review", gh_updated_at: "2026-08-01T12:00:00Z" }),
      row({ number: 2, turn: "mine_review", gh_updated_at: "2026-07-20T12:00:00Z" }), // older
    ];
    expect(pickOneTask(rows)?.number).toBe(2);
  });

  it("returns null when nothing is in my court", () => {
    expect(pickOneTask([row({ turn: "theirs_review" }), row({ turn: "done" })])).toBeNull();
  });
});

function mtg(overrides: Partial<Meeting> = {}): Meeting {
  return { id: "m1", title: "standup", start: "10:00", end: "10:30", kind: "meeting", ...overrides };
}

describe("scheduleDay", () => {
  const task = (n: number, mins = 30) => ({ n, mins });

  it("schedules the first task at startMin, not the top of the day", () => {
    const { day } = scheduleDay([task(1)], [], 11 * 60);
    expect(day[0].start).toBe("11:00a");
  });

  it("defaults to a 9:00 start", () => {
    const { day } = scheduleDay([task(1)], []);
    expect(day[0].start).toBe("9:00a");
  });

  it("packs tasks around a meeting: fits one before, rest after", () => {
    const { day } = scheduleDay([task(1, 30), task(2, 30)], [mtg({ start: "11:30", end: "12:00" })], 11 * 60);
    expect(day.map((d) => d.start)).toEqual(["11:00a", "11:30a", "12:00p"]);
    expect(day[1].type).toBe("meeting");
  });

  it("an in-progress meeting (started before startMin) leads; tasks start after it ends", () => {
    const { day } = scheduleDay([task(1)], [mtg({ start: "10:30", end: "11:15" })], 11 * 60);
    expect(day[0].type).toBe("meeting");
    expect(day[1].start).toBe("11:15a");
  });

  it("stops placing tasks at the focus cap and reports the rest as deferred", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(i, 60)); // 20h of work
    const { focusUsed, deferred } = scheduleDay(tasks, []);
    expect(focusUsed).toBeLessThanOrEqual(FOCUS_CAP);
    expect(deferred).toBe(20 - focusUsed / 60);
  });

  it("court-zero lands startMin + focus time later", () => {
    const { courtZero } = scheduleDay([task(1, 45)], [], 11 * 60);
    expect(courtZero).toBe("11:45a");
  });
});
