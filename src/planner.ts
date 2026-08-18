// The planner: choose *the one task* to work on right now, rank the rest,
// and schedule the day. Pure functions — no I/O — so all of it is unit-testable.

import type { StoredPr } from "./db.js";
import type { Meeting } from "./broker.js";

// Turns where the ball is in my court, most-important first.
// People-first: things others asked of me (review, respond) outrank my own work.
export const TURN_PRIORITY: string[] = [
  "mine_review", // someone asked me to review — a responsibility to them
  "mine_respond", // someone asked me to address their comments
  "ready_merge", // a quick win that unblocks the PR
  "mine_fix", // my own failing CI / conflict
  "mine_request_review", // my PR needs a reviewer assigned
];

export function isActionable(pr: StoredPr, order: string[] = TURN_PRIORITY): boolean {
  return order.includes(pr.turn);
}

/** Lower is more urgent. Sort key: [turn priority, staleness]. */
export function taskRank(pr: StoredPr, order: string[] = TURN_PRIORITY): [number, number] {
  const pri = order.indexOf(pr.turn);
  // Older gh_updated_at = more stale = more urgent → ascending timestamp.
  const staleness = pr.gh_updated_at ? Date.parse(pr.gh_updated_at) : Number.MAX_SAFE_INTEGER;
  return [pri < 0 ? Number.MAX_SAFE_INTEGER : pri, staleness];
}

/** All actionable tasks, most-important first (per the given turn order). */
export function rankTasks(rows: StoredPr[], order: string[] = TURN_PRIORITY): StoredPr[] {
  return rows
    .filter((r) => isActionable(r, order))
    .sort((a, b) => {
      const ra = taskRank(a, order), rb = taskRank(b, order);
      return ra[0] - rb[0] || ra[1] - rb[1];
    });
}

/** The single most important thing to do right now, or null if the court is clear. */
export function pickOneTask(rows: StoredPr[], order: string[] = TURN_PRIORITY): StoredPr | null {
  return rankTasks(rows, order)[0] ?? null;
}

// ---- day scheduling (all times = minutes since local midnight) ----

export const DAY_START = 9 * 60; // 9:00 local
export const FOCUS_CAP = 480; // one day = 8h of focused work

export const parseHM = (s: string): number => {
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : DAY_START;
};

export function fmtHM(min: number): string {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h >= 12 ? "p" : "a";
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ap}`;
}

export interface DayPlan {
  day: Array<Record<string, unknown>>;
  focusUsed: number;
  courtZero: string;
  deferred: number;
}

/**
 * Schedule ranked tasks around meetings into a day timeline. `startMin` is when
 * focus time begins — pass the current time when planning today, so nothing is
 * slotted into the past. A meeting that started before `startMin` but hasn't
 * ended still leads the day; callers should drop meetings that are already over.
 */
export function scheduleDay<T extends { mins: number }>(
  ranked: T[],
  meetings: Meeting[],
  startMin: number = DAY_START,
  focusCap: number = FOCUS_CAP,
): DayPlan {
  const mtgs = [...meetings].sort((a, b) => parseHM(a.start) - parseHM(b.start));
  const day: Array<Record<string, unknown>> = [];
  let cursor = Math.min(startMin, mtgs.length ? parseHM(mtgs[0].start) : startMin);
  let focusUsed = 0;
  let ti = 0;
  let mi = 0;
  const placeMeeting = () => {
    const mtg = mtgs[mi];
    day.push({ type: "meeting", id: mtg.id, start: fmtHM(parseHM(mtg.start)), title: mtg.title, kind: mtg.kind, mins: parseHM(mtg.end) - parseHM(mtg.start) });
    cursor = Math.max(cursor, parseHM(mtg.end));
    mi++;
  };
  while (mi < mtgs.length || (ti < ranked.length && focusUsed < focusCap)) {
    const nextMStart = mi < mtgs.length ? parseHM(mtgs[mi].start) : Infinity;
    const canTask = ti < ranked.length && focusUsed < focusCap;
    if (mi < mtgs.length && cursor >= nextMStart) { placeMeeting(); continue; }
    if (canTask) {
      const t = ranked[ti];
      if (mi < mtgs.length && cursor + t.mins > nextMStart) { placeMeeting(); continue; }
      day.push({ ...t, start: fmtHM(cursor) });
      cursor += t.mins;
      focusUsed += t.mins;
      ti++;
      continue;
    }
    if (mi < mtgs.length) { placeMeeting(); continue; }
    break;
  }
  return { day, focusUsed, courtZero: fmtHM(cursor), deferred: ranked.length - ti };
}
