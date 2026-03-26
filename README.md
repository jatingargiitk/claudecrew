# 🐙 Claude Crew — Parallel Claude Code Workers

<!-- LOGO PLACEHOLDER: replace with your mascot image -->
<!-- <p align="center"><img src="docs/assets/logo.png" width="200" /></p> -->

<p align="center">
  <strong>One prompt. Multiple Claude workers. Parallel coding sessions that build entire modules simultaneously.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#examples">Examples</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#mcp-tools">MCP Tools</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/claude_code-v2.1+-7c3aed?logo=anthropic" alt="Claude Code" />
  <img src="https://img.shields.io/badge/protocol-MCP-0ea5e9" alt="MCP" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="MIT" />
</p>

## Demo

<p align="center">
  <a href="https://www.youtube.com/watch?v=AWmRSnKAwH4">
    <img src="https://img.youtube.com/vi/AWmRSnKAwH4/maxresdefault.jpg" alt="Claude Crew Demo — microservices built by 5 parallel workers" width="720" />
  </a>
  <br />
  <em>▶ One prompt → 5 parallel workers → microservices that talk to each other</em>
</p>

---

Claude Code is powerful but sequential. **Claude Crew makes it parallel** — auto-spawning worker sessions that build entire backends, frontends, and microservices simultaneously. One terminal, zero setup.

```
  You: "Build a full-stack task manager"

  ┌──────────────────────────────────┐
  │  Leader (your Claude session)    │
  │  creates shared types            │
  │  calls crew.fan_out              │
  └──────────┬───────────────────────┘
             │ auto-spawns
        ┌────┴────┐
        ▼         ▼
    worker 1   worker 2       ← claude -p (ephemeral)
    entire     entire         ← each builds a full domain
    backend    frontend
        │         │
        └────┬────┘
             ▼
  ┌──────────────────────────────────┐
  │  Leader collects, type-checks,   │
  │  smoke-tests, reports            │
  └──────────────────────────────────┘

  ✓ 2 workers · 0 failures · 4m 45s
```

## Quick Start

Runtime: **[Bun](https://bun.sh) v1.0+** and **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1+**.

```bash
# Install
git clone https://github.com/jatingarg/claudecrew.git ~/claudecrew
cd ~/claudecrew && bun install

# Set up your project
cd /path/to/your/project
bun ~/claudecrew/cli.ts init    # writes .mcp.json
bun ~/claudecrew/cli.ts up      # starts orchestrator

# Go
claude --dangerously-skip-permissions
```

Then describe what you want to build. Claude Crew automatically fans out the work — no special keywords needed.

**Tip:** add an alias so you can type `crew` instead of `bun ~/claudecrew/cli.ts`:

```bash
echo 'alias crew="bun ~/claudecrew/cli.ts"' >> ~/.zshrc
source ~/.zshrc
```

All examples below use the `crew` alias. Without it, replace `crew` with `bun ~/claudecrew/cli.ts`.

## Examples

### Build a full-stack app from scratch

Empty folder to working app in under 5 minutes. Tested, verified, working.

```bash
mkdir my-app && cd my-app
crew init && crew up
claude --dangerously-skip-permissions
```

> Build a task management app. Backend: Express API with TypeScript, CRUD endpoints for tasks (title, description, status, priority, due date), in-memory store. Frontend: React + Vite + Tailwind, pages for task list with filters, task detail view, and create/edit form.

**What happens:**

1. Leader creates shared types
2. Calls `crew.fan_out` — spawns 2 workers
3. Worker 1 builds the **entire backend** (Express, routes, store, middleware, `npm install`)
4. Worker 2 builds the **entire frontend** (Vite, React, Tailwind, pages, components, `npm install`)
5. Leader collects results, type-checks both, smoke-tests the API
6. Working full-stack app with seed data, filtering, CRUD

### Migrate a codebase from JS to TypeScript

> Migrate this entire codebase from JavaScript to TypeScript. Add proper types, rename files, update imports, add tsconfig.json.

Workers split by module — each migrates a different directory simultaneously. What normally takes 2+ hours finishes in 15 minutes.

### Review a backlog of pull requests

> Review all open pull requests on this repo. For each PR: read the diff, check for bugs and security issues, leave a summary comment with actionable feedback.

Each worker reviews a different PR in parallel. Clear a 20-PR backlog while you grab coffee.

### Build microservices that talk to each other

> Build an e-commerce system with 3 microservices: user-service (auth + profiles), product-service (catalog + search), order-service (cart + checkout). Each is a standalone Express app. They communicate via REST. Include a docker-compose.yml.

Each worker builds an **entire microservice**. They actually communicate when you run `docker-compose up`.

### Write tests for an untested codebase

> Write comprehensive tests for every module in this project. Unit tests for utilities, integration tests for API routes, component tests for React components. Target 80%+ coverage.

Workers split by directory. Go from 0% to 80%+ coverage in a single run.

## How It Works

An orchestrator daemon runs on `localhost:7900` (SQLite for state). The MCP server exposes `crew.*` tools to your Claude session.

When `crew.fan_out` is called:

1. Creates a job in the orchestrator
2. Spawns ephemeral `claude -p` processes — one per subtask
3. Each worker runs with `--bare --dangerously-skip-permissions` (fast startup, no prompts)
4. Workers execute, output JSON results, and exit
5. MCP server captures output and reports to the orchestrator

```
                  ┌───────────────────────────┐
                  │   Orchestrator daemon      │
                  │   localhost:7900 + SQLite  │
                  └──────────┬────────────────┘
                             │
                       MCP server (stdio)
                       in your Claude session
                             │
                  ┌──────────┼──────────┐
                  │          │          │
             claude -p  claude -p  claude -p
              worker     worker     worker
```

Workers are ephemeral — execute, report, exit. The leader orchestrates everything.

### Key design decisions

- **Domain-level splitting** — workers get entire modules ("build the whole backend"), not individual files
- **2-4 big subtasks** — not 10 small ones. Each worker is a full Claude instance
- **Zero config** — MCP server auto-launches the orchestrator, workers inherit your Claude auth
- **File claiming** — orchestrator prevents concurrent edits to the same file via SQLite mutex

## MCP Tools

| Tool | Description |
|------|-------------|
| `crew.fan_out` | Split a task into 2-4 domain-level subtasks, spawn parallel workers |
| `crew.status` | Check progress — which workers are done, running, or failed |
| `crew.collect` | Gather results from all workers when the job completes |
| `crew.cancel` | Cancel a job and kill all running worker processes |

### crew.fan_out parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `task` | Yes | — | High-level task description |
| `subtasks` | Yes | — | Array of `{ description, files? }` — each an entire domain |
| `context` | No | — | Shared context for all workers (types, conventions, API contracts) |
| `timeout_seconds` | No | `300` | Per-worker timeout |
| `max_workers` | No | `5` | Max concurrent worker processes |
| `model` | No | system default | Model for workers (e.g. `"sonnet"` for cost savings) |

## CLI

With the `crew` alias (see [Quick Start](#quick-start)):

```bash
crew init              # set up .mcp.json in current project
crew up                # start orchestrator daemon
crew down              # stop orchestrator daemon
crew status            # orchestrator health + job count
crew jobs              # list all jobs
crew job <job_id>      # detailed subtask status
crew cancel <job_id>   # cancel a running job
```

Without the alias, use `bun ~/claudecrew/cli.ts` instead of `crew`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CREW_PORT` | `7900` | Orchestrator HTTP port |
| `CREW_DB` | `~/.claudecrew.db` | SQLite database path |

## Architecture

```
claudecrew/
├── server.ts          # MCP stdio server — exposes crew.* tools, spawns workers
├── orchestrator.ts    # HTTP daemon on :7900 — tracks jobs, subtasks, file claims
├── store.ts           # SQLite schema and data access layer
├── cli.ts             # CLI for init, daemon management, job monitoring
└── shared/types.ts    # Shared TypeScript types for orchestrator API
```

## Roadmap

**Now** — core auto-spawn works. One prompt fans out to parallel workers that build entire domains.

**Next**
- Dependency ordering (`depends_on`) — "build pages" waits for "scaffold project"
- Shared context / memory — workers can read what other workers have built
- Error recovery — auto-retry failed workers before marking failed
- Live progress streaming — see worker output in real-time

**Later**
- Multi-stage pipelines — sequential stages with parallel workers within each
- Git worktree isolation — each worker gets its own branch, leader merges
- `npx claudecrew init` — zero-install setup via npm
- Web dashboard — live UI showing worker progress, logs, and cost
- Remote workers — fan out across machines via SSH

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1+
- Claude login (`claude auth login`) — workers use your account

## Community

PRs welcome! Built with Claude Code + Claude Crew (yes, we used it to build itself).

<!-- Uncomment when repo is public:
## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jatingarg/claudecrew&type=date)](https://star-history.com/#jatingarg/claudecrew)
-->
# claudecrew
