import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

// Model per reasoning job — tune the model/cost tradeoff without touching code.
// enrich = the context you actually read (best model); prioritize = triage (keep mid);
// meeting/ping = simple drafting. Review/fix agents use your `claude` CLI default.
export interface Models {
  enrich: string;
  prioritize: string;
  meeting: string;
  ping: string;
  brief: string;
}

export interface Config {
  me: string; // my GitHub login
  repos: string[]; // "owner/name"
  signalChannels: string[]; // Slack channels that carry incident/customer/escalation signal, for impact ranking
  budget: { dailyUsd: number; dailyTokens: number }; // per-day spend caps shown in the UI
  autoSpend: boolean; // true = auto-run reasoning spends (prioritize/gather/rank); false = every spend is a click
  models: Models; // per-job model selection
}

// State dir. New installs get ~/.dontpanic; existing ~/.prclear installs keep working.
// Override with DONTPANIC_HOME.
export const DIR =
  process.env.DONTPANIC_HOME ||
  (existsSync(join(homedir(), ".prclear")) ? join(homedir(), ".prclear") : join(homedir(), ".dontpanic"));
const CONFIG_PATH = join(DIR, "config.json");
export const DB_PATH = join(DIR, "prclear.db");
export const CLONES_DIR = join(DIR, "clones");

const DEFAULT: Config = {
  me: "", // captured on first run from your gh login
  repos: [], // set via `dontpanic setup`
  signalChannels: [], // e.g. ["incidents", "support"] — optional, sharpens impact ranking
  budget: { dailyUsd: 15, dailyTokens: 2_000_000 },
  autoSpend: false, // default: you click every spend
  models: {
    enrich: "claude-opus-4-8", // best model for the orientation/gaps you rely on
    prioritize: "claude-sonnet-5", // triage — mid model, kept lean via cached context
    meeting: "claude-sonnet-5", // calendar tool use (haiku wanders on tool use)
    ping: "claude-sonnet-5", // Slack user lookup + drafting
    brief: "claude-sonnet-5", // per-PR state + suggested changes (diff-fed, no tools)
  },
};

export function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function saveConfig(cfg: Config): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function loadConfig(): Config {
  ensureDir();
  if (!existsSync(CONFIG_PATH)) return DEFAULT; // first-run: use defaults until `dontpanic setup`
  const file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  return {
    ...DEFAULT, ...file,
    budget: { ...DEFAULT.budget, ...(file.budget || {}) },
    models: { ...DEFAULT.models, ...(file.models || {}) },
  };
}

/** True once the user has set the repos to watch (i.e. completed setup). */
export function isConfigured(): boolean {
  return configExists() && loadConfig().repos.length > 0;
}
