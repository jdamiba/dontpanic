import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configExists, saveConfig, loadConfig, DIR } from "../config.js";

const execFileP = promisify(execFile);

/** Best-effort GitHub login from the authed gh CLI, to prefill the prompt. */
async function ghLogin(): Promise<string> {
  try { return JSON.parse((await execFileP("gh", ["api", "user", "--jq", "{login}"])).stdout).login || ""; }
  catch { return ""; }
}

/** First-run (or `dontpanic setup`): capture GitHub login, repos, and optional signal channels. */
export async function runSetup(force = false): Promise<void> {
  if (configExists() && !force) return;

  const cur = loadConfig();
  const meDefault = cur.me || (await ghLogin()); // resolve before opening readline

  // Buffer input lines into a queue so lines emitted before a prompt (e.g. piped stdin)
  // aren't lost, and pending prompts resolve to their default on EOF.
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let closed = false;
  rl.on("line", (l) => { const w = waiters.shift(); w ? w(l) : queue.push(l); });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()!(null); });
  const nextLine = (): Promise<string | null> =>
    new Promise((res) => (queue.length ? res(queue.shift()!) : closed ? res(null) : waiters.push(res)));
  const ask = async (q: string, def: string): Promise<string> => {
    process.stdout.write(`  ${q}${def ? ` [${def}]` : ""}: `);
    const l = await nextLine();
    return (l ?? "").trim() || def;
  };

  console.log(`\nQuick setup (saved to ${DIR}/config.json):\n`);
  const me = await ask("Your GitHub login", meDefault);
  const reposRaw = await ask("Repos to watch (owner/name, comma-separated)", cur.repos.join(", "));
  const chRaw = await ask("Slack channels for incident/customer signal (optional, comma-separated)", cur.signalChannels.join(", "));
  rl.close();

  const repos = reposRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const signalChannels = chRaw.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
  saveConfig({ ...cur, me, repos, signalChannels }); // preserve budget/models + any other fields
  console.log(
    repos.length
      ? `\n  Saved — watching ${repos.join(", ")} as @${me}.\n  Run  dontpanic dashboard  to start.\n`
      : `\n  Saved, but no repos set yet — run  dontpanic setup  again and add at least one "owner/name" repo.\n`,
  );
}
