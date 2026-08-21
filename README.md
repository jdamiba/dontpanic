# dontpanic

**A calm command center + coach for clearing your agentic-coding PR backlog.**

dontpanic pulls your open pull requests — the ones you authored and the ones you owe reviews on — and helps you clear them: it picks the highest-**customer-impact** thing to do next and says why, briefs you on each PR's state and the changes it needs, and launches an agent to **review** or **fix** it while you supervise. You approve every write.

It has no API keys of its own. All the AI work is done by shelling out to your **Claude Code CLI**, reusing *your* authenticated claude.ai connectors (Slack, Linear, Google Calendar) and GitHub via `gh`. That means GitHub data is free, and every token-spending action is a clearly-priced button — dontpanic never spends without you clicking.

---

## Screenshots

**The Board** — every PR in your court, ranked by customer impact, each with a per-PR brief (state + suggested changes):

![Board](assets/board.png)

**Now** — a single-task cockpit: a day timeline, why-this-is-first, missing-context flags, and orientation:

![Now cockpit](assets/now.png)

**Launch an agent** — it streams its reasoning live, then drafts a cited verdict you approve (or not):

![Agent streaming](assets/agent.png)

**Parallel** — resolve several PRs side by side, each with its own gated approve/push:

![Parallel resolution](assets/parallel.png)

> Try the UI yourself with no setup or tokens: `dontpanic dashboard --demo` (canned data).

---

## Prerequisites

dontpanic drives tools you already have. Before it can do anything useful:

1. **Node ≥ 20**
2. **[GitHub CLI](https://cli.github.com/) (`gh`), authenticated** — `gh auth login`. All PR reads/writes go through it.
3. **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`), signed in** — this is the agent dontpanic drives for reasoning, review, and fixes.
   - For the context/impact features, connect **Slack**, **Linear**, and **Google Calendar** in your Claude account. dontpanic reaches them *through* the `claude` CLI — no separate tokens.
4. **(optional) [Codex CLI](https://github.com/openai/codex) (`codex`)** — a second agent backend, offered in the UI only if installed.

Run `dontpanic doctor` any time to check all of the above.

---

## Quick start

```bash
# 1. First run: explains what it does, checks prerequisites, and sets up your repos
npx @jdamiba/dontpanic

# 2. Start the dashboard (fetches your PRs + optional calendar, then serves a local UI)
npx @jdamiba/dontpanic dashboard
# → open http://localhost:4711
```

Setup asks for your GitHub login, the repos to watch (`owner/name`, comma-separated), and — optionally — the Slack channels that carry incident/customer signal (to sharpen impact ranking).

---

## Commands

| Command | What it does |
|---|---|
| `dontpanic` | Welcome + prerequisite check + first-run setup |
| `dontpanic setup` | Set your GitHub login, repos, and signal channels |
| `dontpanic doctor` | Verify `claude` / `gh` / connectors are ready |
| `dontpanic dashboard` | Start the local dashboard (`--port`, `--no-sync`) |
| `dontpanic sync` | Refresh open PRs into the local store (GitHub only, free) |
| `dontpanic list` | Print PRs grouped by whose turn it is |

---

## The token model

- **GitHub data is free** — sync, the board, and whose-turn logic cost nothing.
- **AI work costs tokens** — impact ranking, per-PR briefs, full context, and the review/fix agents. Each is a **clearly-priced button**, and dontpanic **never spends without your click**.
- Every button shows its cost **and** what fraction of your **daily limit** it represents; toggle the header between dollars and tokens.
- Results are **cached**, so re-viewing costs nothing; only a changed PR re-bills.
- Writes to GitHub (submit a review, push a fix) and Slack (notify a colleague) are always **two-click, human-gated** — even in the parallel/burndown flows.

Set your daily caps and per-job models in `~/.dontpanic/config.json` (`budget`, `models`). Existing `~/.prclear` installs keep working; override the location with `DONTPANIC_HOME`.

---

## What it can do

- **Board** — every PR in your court, ranked by customer impact, with a per-PR brief (state + suggested changes).
- **Now** — a single-task cockpit: orientation, acceptance criteria, missing-context flags, and a launch-an-agent panel that streams the agent's reasoning live.
- **Parallel** — select several PRs and resolve them side by side, each with its own gated approve/push.
- **Burndown** — supervise an agent working down the whole court, one task at a time.
- **Coach** — each task surfaces a CS/process lesson so you get better at agentic coding as you clear the backlog.

---

## Customize the AI to your team

dontpanic's defaults are opinions, and you can override them without touching code — drop optional markdown files in your config dir (`~/.dontpanic/`), like a `CLAUDE.md` for your PR workflow:

| File | Shapes | Example |
|---|---|---|
| `prioritization.md` | How PRs are ranked ("what to do first") | *"Rank by: 1) customer SLA breaches, 2) PRs blocking a teammate, 3) security. Deprioritize refactors."* |
| `review-guidelines.md` | House rules the review + fix agents apply | *"- Use Conventional Commits. - Flag any new N+1 query. - Require a test for every bugfix."* |

If a file is absent, the built-in default is used. `dontpanic doctor` shows which are active, and the "view the exact prompt" panel in the UI reflects them.

Structured settings live in `~/.dontpanic/config.json`:

| Key | What it controls |
|---|---|
| `repos`, `me` | Which repos to watch, and your GitHub login |
| `signalChannels` | Slack channels searched for incident/customer signal |
| `budget` | Daily $ and token caps shown in the UI |
| `models` | Per-job model (`enrich`, `prioritize`, `brief`, `meeting`, `ping`) |
| `defaultAgent` | `claude` or `codex` for review/fix (picker overrides per-launch) |
| `autoSpend` | Auto-run the reasoning reads vs. click every spend |
| `workday` | `{ "start": "09:00", "focusHours": 8 }` — the day timeline |
| `turnOrder` | Order your court is worked, e.g. own-CI-first vs. reviews-first (a permutation of the 5 turns; invalid → default) |
| `coaching` | `true`/`false` — show the "learn as you close this" element |
| `repoTypes` | Per-repo change-type hint for non-JS/Python stacks, e.g. `{ "me/api": "backend" }` |

## License

MIT © Joseph Damiba
