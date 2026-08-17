import { allPrs, type StoredPr } from "../db.js";
import { AUTHOR_TURN_ORDER, REVIEWER_TURN_ORDER, isMyTurn } from "../turn.js";
import type { Role } from "../types.js";

export interface ListOpts {
  mine?: boolean;
  review?: boolean;
  turn?: string;
}

const shortRepo = (r: string) => r.split("/").pop() ?? r;

const CI_ICON: Record<string, string> = {
  passing: "✓", // check
  failing: "✗", // cross
  pending: "·", // middot
  none: " ",
};

function reviewersOf(p: StoredPr): string[] {
  return JSON.parse(p.requested_reviewers || "[]") as string[];
}

function printGroup(role: Role, rows: StoredPr[], order: string[], filterTurn?: string): void {
  const label = role === "author" ? "MY PRs" : "TO REVIEW";
  console.log(`\n=== ${label} (${rows.length}) ===`);
  for (const turn of order) {
    if (filterTurn && turn !== filterTurn) continue;
    const group = rows.filter((r) => r.turn === turn);
    if (!group.length) continue;
    const flag = isMyTurn(turn as never) ? "▶" : " ";
    console.log(`\n${flag} ${turn}  (${group.length})`);
    for (const p of group.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)) {
      const who =
        role === "author" ? reviewersOf(p).join(",") || "—" : p.author;
      const title = p.title.length > 58 ? p.title.slice(0, 57) + "…" : p.title;
      console.log(
        `    ${CI_ICON[p.ci_status] ?? " "} ${shortRepo(p.repo)}#${p.number}`.padEnd(34) +
          `${who}`.padEnd(22) +
          title,
      );
    }
  }
}

export function list(opts: ListOpts): void {
  const showMine = opts.mine || (!opts.mine && !opts.review);
  const showReview = opts.review || (!opts.mine && !opts.review);

  if (showMine) printGroup("author", allPrs("author"), AUTHOR_TURN_ORDER, opts.turn);
  if (showReview) printGroup("reviewer", allPrs("reviewer"), REVIEWER_TURN_ORDER, opts.turn);
  console.log();
}
