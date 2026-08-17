// Token-spend tracking. Every agent (`claude -p` / `codex exec`) call reports a cost
// AND a token count, tagged with the KIND of action (review, fix, enrich, …). We record
// both so the UI can show what's been spent against the user's daily limit — and we keep
// a per-kind running average so the pre-spend estimates get more accurate over time.
// Codex bills the ChatGPT plan (no USD) but still consumes tokens. Persisted to
// ~/.prclear/spend.json.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DIR, loadConfig } from "./config.js";

const FILE = join(DIR, "spend.json");
let sessionUsd = 0;
let sessionTokens = 0;

interface DayRec { usd: number; tokens: number; }
interface KindStat { n: number; usd: number; tokens: number; }
interface Store { days: Record<string, DayRec>; stats: Record<string, KindStat>; }

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function coerceDay(v: unknown): DayRec {
  if (typeof v === "number") return { usd: v, tokens: 0 }; // oldest format: usd-only number
  const o = (v as Partial<DayRec>) || {};
  return { usd: o.usd || 0, tokens: o.tokens || 0 };
}

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    if (raw && typeof raw === "object" && "days" in raw) {
      const r = raw as { days?: Record<string, unknown>; stats?: Record<string, KindStat> };
      const days: Record<string, DayRec> = {};
      for (const [k, v] of Object.entries(r.days || {})) days[k] = coerceDay(v);
      return { days, stats: r.stats || {} };
    }
    // Migrate the flat `{ [date]: number | {usd,tokens} }` format into { days, stats }.
    const days: Record<string, DayRec> = {};
    for (const [k, v] of Object.entries(raw || {})) days[k] = coerceDay(v);
    return { days, stats: {} };
  } catch { return { days: {}, stats: {} }; }
}

function save(s: Store): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(s));
  } catch { /* best effort */ }
}

/** Record a spend, tagged with the action kind so we can learn per-kind averages. */
export function recordSpend(kind: string, costUsd?: number | null, tokens?: number | null): void {
  const u = costUsd && costUsd > 0 ? costUsd : 0;
  const t = tokens && tokens > 0 ? tokens : 0;
  if (!u && !t) return;
  sessionUsd += u; sessionTokens += t;
  const s = load();
  const k = today();
  const d = s.days[k] || { usd: 0, tokens: 0 };
  d.usd += u; d.tokens += t; s.days[k] = d;
  if (kind) {
    const st = s.stats[kind] || { n: 0, usd: 0, tokens: 0 };
    st.n += 1; st.usd += u; st.tokens += t; s.stats[kind] = st;
  }
  save(s);
}

export interface SpendSummary {
  today: number; session: number;
  todayTokens: number; sessionTokens: number;
  limitUsd: number; limitTokens: number;
}

export function spendSummary(): SpendSummary {
  const s = load();
  const d = s.days[today()] || { usd: 0, tokens: 0 };
  const b = loadConfig().budget;
  return {
    today: d.usd, session: sessionUsd,
    todayTokens: d.tokens, sessionTokens,
    limitUsd: b.dailyUsd, limitTokens: b.dailyTokens,
  };
}

// Starting estimates, used until enough real runs exist to average from.
const EST_USD_DEFAULT: Record<string, number> = { prioritize: 0.5, enrich: 0.7, review: 1.0, fix: 2.0, meeting: 0.2, ping: 0.15, brief: 0.15 };
const EST_TOK_DEFAULT: Record<string, number> = { prioritize: 35_000, enrich: 45_000, review: 70_000, fix: 120_000, meeting: 15_000, ping: 10_000, brief: 40_000 };
const LEARN_MIN = 2; // need at least this many real runs before trusting the learned mean

export interface Estimate { usd: number; tokens: number; n: number; learned: boolean; }

/** Per-action estimates: the learned average once we have ≥LEARN_MIN runs, else the default. */
export function estimates(): Record<string, Estimate> {
  const s = load();
  const out: Record<string, Estimate> = {};
  for (const kind of Object.keys(EST_USD_DEFAULT)) {
    const st = s.stats[kind];
    if (st && st.n >= LEARN_MIN) out[kind] = { usd: st.usd / st.n, tokens: st.tokens / st.n, n: st.n, learned: true };
    else out[kind] = { usd: EST_USD_DEFAULT[kind], tokens: EST_TOK_DEFAULT[kind], n: st?.n || 0, learned: false };
  }
  return out;
}
