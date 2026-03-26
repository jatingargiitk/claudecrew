#!/usr/bin/env bun
/**
 * Claude Crew MCP server — auto-spawn architecture
 *
 * When the leader calls crew.fan_out, worker Claude processes are
 * spawned automatically as `claude -p "task" --bare --dangerously-skip-permissions`.
 * No extra terminals, no permission prompts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  FanOutResponse,
  StatusResponse,
  CollectResponse,
} from "./shared/types.ts";
import { existsSync } from "fs";
import { resolve } from "path";

// --- Configuration ---

const ORCH_PORT = parseInt(process.env.CREW_PORT ?? "7900", 10);
const ORCH_URL = `http://127.0.0.1:${ORCH_PORT}`;
const ORCH_SCRIPT = new URL("./orchestrator.ts", import.meta.url).pathname;
const IS_WORKER = process.env.CREW_WORKER === "1";
const MAX_CONCURRENT_DEFAULT = 5;
const MAX_TURNS_DEFAULT = 50;

// --- Active worker tracking (for cancellation) ---

interface WorkerHandle {
  proc: ReturnType<typeof Bun.spawn>;
  subtaskId: string;
}

const activeWorkers = new Map<string, WorkerHandle[]>();

// --- HTTP helpers ---

async function orchFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ORCH_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Orchestrator error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isOrchestratorAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${ORCH_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureOrchestrator(): Promise<void> {
  if (await isOrchestratorAlive()) {
    log("Orchestrator already running");
    return;
  }

  log("Starting orchestrator daemon...");
  const proc = Bun.spawn(["bun", ORCH_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isOrchestratorAlive()) {
      log("Orchestrator started");
      return;
    }
  }
  throw new Error("Failed to start orchestrator daemon after 6 seconds");
}

function log(msg: string) {
  console.error(`[claudecrew] ${msg}`);
}

// --- Worker spawning ---

interface SubtaskInfo {
  subtask_id: string;
  description: string;
  files: string[];
}

function buildWorkerPrompt(subtask: SubtaskInfo, context?: string): string {
  const lines = [
    "You are a coding worker executing a specific subtask as part of a larger project.",
    "",
    "## Your Task",
    subtask.description,
    "",
  ];

  if (subtask.files.length > 0) {
    lines.push("## Files to Modify");
    for (const f of subtask.files) lines.push(`- ${f}`);
    lines.push("");
  }

  if (context) {
    lines.push("## Context", context, "");
  }

  lines.push(
    "## Instructions",
    "1. Read the relevant files to understand the current code",
    "2. Make the changes described above",
    "3. Verify your changes are syntactically correct",
    "4. Print a concise summary: files modified, specific changes made",
    "",
    "Execute the task completely and autonomously. Do NOT ask questions.",
  );

  return lines.join("\n");
}

async function spawnSingleWorker(
  jobId: string,
  subtask: SubtaskInfo,
  context: string | undefined,
  cwd: string,
  timeoutMs: number,
  model?: string,
): Promise<void> {
  const prompt = buildWorkerPrompt(subtask, context);

  await orchFetch("/accept", { subtask_id: subtask.subtask_id });

  let killed = false;
  const timeoutId = setTimeout(() => {
    killed = true;
    const workers = activeWorkers.get(jobId);
    const handle = workers?.find((w) => w.subtaskId === subtask.subtask_id);
    if (handle) {
      try {
        handle.proc.kill();
      } catch {}
    }
  }, timeoutMs);

  try {
    log(`Spawning worker for ${subtask.subtask_id}...`);

    const args = [
      "claude",
      "-p",
      prompt,
      "--bare",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--max-turns",
      String(MAX_TURNS_DEFAULT),
    ];

    if (model) args.push("--model", model);

    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CREW_WORKER: "1" },
    });

    const workers = activeWorkers.get(jobId) ?? [];
    workers.push({ proc, subtaskId: subtask.subtask_id });
    activeWorkers.set(jobId, workers);

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    clearTimeout(timeoutId);

    const remaining = (activeWorkers.get(jobId) ?? []).filter(
      (w) => w.subtaskId !== subtask.subtask_id,
    );
    if (remaining.length > 0) {
      activeWorkers.set(jobId, remaining);
    } else {
      activeWorkers.delete(jobId);
    }

    let resultText: string;
    let isError = false;

    try {
      const json = JSON.parse(output);
      resultText = json.result ?? output;
      isError = json.is_error === true;
    } catch {
      resultText = output || "(no output)";
    }

    if (killed) {
      log(`Worker ${subtask.subtask_id} timed out`);
      await orchFetch("/fail", {
        subtask_id: subtask.subtask_id,
        error: `Worker timed out after ${timeoutMs / 1000}s`,
      });
    } else if (!isError && exitCode === 0) {
      log(`Worker ${subtask.subtask_id} completed`);
      await orchFetch("/complete", {
        subtask_id: subtask.subtask_id,
        result: resultText,
        files_changed: subtask.files,
      });
    } else {
      const errorMsg = isError
        ? resultText
        : `Worker exited with code ${exitCode}: ${resultText.slice(0, 500)}`;
      log(`Worker ${subtask.subtask_id} failed: ${errorMsg.slice(0, 100)}`);
      await orchFetch("/fail", {
        subtask_id: subtask.subtask_id,
        error: errorMsg,
      });
    }
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error ? e.message : String(e);
    log(`Worker ${subtask.subtask_id} error: ${msg}`);
    try {
      await orchFetch("/fail", {
        subtask_id: subtask.subtask_id,
        error: msg,
      });
    } catch {}
  }
}

function spawnWorkersInBackground(
  jobId: string,
  subtasks: SubtaskInfo[],
  context: string | undefined,
  cwd: string,
  maxConcurrent: number,
  timeoutMs: number,
  model?: string,
) {
  (async () => {
    const queue = [...subtasks];
    const running = new Set<Promise<void>>();

    while (queue.length > 0 || running.size > 0) {
      while (running.size < maxConcurrent && queue.length > 0) {
        const subtask = queue.shift()!;
        const promise = spawnSingleWorker(
          jobId,
          subtask,
          context,
          cwd,
          timeoutMs,
          model,
        ).finally(() => running.delete(promise));
        running.add(promise);
      }
      if (running.size > 0) {
        await Promise.race(running);
      }
    }

    log(`All workers for job ${jobId} finished`);
  })().catch((e) => {
    log(
      `Worker pool error: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claudecrew", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: IS_WORKER
      ? undefined
      : `You have Claude Crew installed. It spawns parallel Claude worker processes to divide and conquer any large task.

## CRITICAL RULE: Split by DOMAIN, not by file
Each subtask you create should be a LARGE, self-contained domain of work — NOT a single file. Each worker is a full Claude Code instance that can create dozens of files, install packages, run commands, and architect entire subsystems.

**WRONG — too granular (DO NOT do this):**
- Subtask 1: "Create StartScreen.tsx"
- Subtask 2: "Create QuizScreen.tsx"
- Subtask 3: "Create ResultsScreen.tsx"

**RIGHT — domain-level (DO this):**
- Subtask 1: "Build the entire backend: Express server, all CRUD API routes, middleware, types, error handling. Create server/ directory with package.json, tsconfig.json, and all source files."
- Subtask 2: "Build the entire frontend: React app with all pages (list, detail, create form), components, routing, API client, styles. Create client/ directory with all source files, Vite config, Tailwind setup."

**More examples:**
- "Build a trivia game" → Worker 1: All game logic + data (questions, scoring, timer, state management, hooks, types — 5-10 files). Worker 2: All UI components + screens + App.tsx + routing + styles (10+ files).
- "Build a SaaS dashboard" → Worker 1: Entire backend API + database. Worker 2: Shared UI components + layout + design system. Worker 3: All dashboard pages + routing.
- "Add auth" → Worker 1: Backend auth (JWT, middleware, user model, auth routes — all files). Worker 2: Frontend auth (login/signup pages, auth context, protected routes, API integration — all files).

AIM FOR 2-4 BIG SUBTASKS, NOT 5-10 SMALL ONES. Each subtask description must be a detailed spec: what to build, what files/folders to create, tech choices, API contracts, data shapes, and how it connects to other parts.

## When to use crew.fan_out
You MUST use crew.fan_out whenever a task involves building multiple independent modules or domains. Do NOT build everything sequentially yourself.

## How it works:
1. First do minimal shared one-time setup yourself (e.g., root package.json, monorepo structure, shared types file).
2. Call crew.fan_out with 2-4 BIG subtasks. Each subtask description should be a thorough spec — include file structure, tech stack, API contracts between modules, data shapes, and conventions. Workers only know what you tell them.
3. Poll crew.status to track progress.
4. Call crew.collect when done to gather results.
5. Do any final integration/cleanup yourself (wire things together, fix cross-module imports), then report to the human.

## Tips:
- Give workers rich context in the description: exact folder structure, naming conventions, API endpoints/shapes, how their piece connects to others.
- Workers can create entire directory trees, install dependencies, write dozens of files, and run commands.
- Use crew.cancel to abort a running job and kill workers.`,
  },
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "crew.fan_out",
    description:
      "Split a task into 2-4 LARGE domain-level subtasks and spawn parallel Claude worker processes. Each worker is a full Claude instance — give it an entire module/domain (e.g. 'build the entire backend', 'build all frontend pages'), NOT individual files. Workers are ephemeral — they run, complete the task, and exit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string" as const,
          description: "High-level description of the overall task",
        },
        subtasks: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              description: {
                type: "string" as const,
                description:
                  "A detailed spec of the ENTIRE domain/module this worker should build. Include: what to build, folder structure, files to create, tech choices, API contracts, data shapes. Be thorough — the worker only knows what you write here.",
              },
              files: {
                type: "array" as const,
                items: { type: "string" as const },
                description: "Optional hint of directories or key files. Workers can create any files they need — this is just a hint for file-claim coordination.",
              },
            },
            required: ["description"],
          },
          description: "Array of subtasks to execute in parallel",
        },
        context: {
          type: "string" as const,
          description:
            "Shared context for all workers (patterns to follow, imports, constraints, code snippets)",
        },
        timeout_seconds: {
          type: "number" as const,
          description: "Timeout per worker in seconds (default: 300)",
        },
        max_workers: {
          type: "number" as const,
          description:
            "Max concurrent worker processes (default: 5). Lower this if you hit rate limits.",
        },
        model: {
          type: "string" as const,
          description:
            'Model for worker processes (e.g. "sonnet", "opus"). Defaults to system default.',
        },
      },
      required: ["task", "subtasks"],
    },
  },
  {
    name: "crew.status",
    description:
      "Check the status of a fan-out job. Shows overall progress and per-subtask status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "string" as const,
          description: "The job ID returned by crew.fan_out",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "crew.collect",
    description:
      "Collect results from a fan-out job. Returns per-subtask results and summaries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "string" as const,
          description: "The job ID returned by crew.fan_out",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "crew.cancel",
    description:
      "Cancel a fan-out job. Kills all running worker processes and marks remaining subtasks as cancelled.",
    inputSchema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "string" as const,
          description: "The job ID to cancel",
        },
      },
      required: ["job_id"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "crew.fan_out": {
        const {
          task,
          subtasks,
          context,
          timeout_seconds,
          max_workers,
          model,
        } = args as {
          task: string;
          subtasks: Array<{ description: string; files?: string[] }>;
          context?: string;
          timeout_seconds?: number;
          max_workers?: number;
          model?: string;
        };

        const result = await orchFetch<FanOutResponse>("/fan-out", {
          task,
          subtasks,
          timeout_seconds,
        });

        const subtaskInfos: SubtaskInfo[] = result.assignments.map(
          (a, i) => ({
            subtask_id: a.subtask_id,
            description: subtasks[i]!.description,
            files: subtasks[i]!.files ?? [],
          }),
        );

        let fullContext = context ?? "";
        const claudeMdPath = resolve(process.cwd(), "CLAUDE.md");
        if (existsSync(claudeMdPath)) {
          try {
            const claudeMd = await Bun.file(claudeMdPath).text();
            fullContext = `Project guidelines:\n${claudeMd}\n\n${fullContext}`;
          } catch {}
        }

        const timeoutMs = (timeout_seconds ?? 300) * 1000;
        const maxConcurrent = max_workers ?? MAX_CONCURRENT_DEFAULT;

        spawnWorkersInBackground(
          result.job_id,
          subtaskInfos,
          fullContext || undefined,
          process.cwd(),
          maxConcurrent,
          timeoutMs,
          model,
        );

        const lines = [
          `Job created: ${result.job_id}`,
          `Spawning ${subtaskInfos.length} worker(s) (max ${maxConcurrent} concurrent)`,
          "",
          "Subtasks:",
          ...subtaskInfos.map(
            (s) =>
              `  ${s.subtask_id}: ${s.description.slice(0, 80)}`,
          ),
          "",
          "Workers execute automatically. Use crew.status to track progress.",
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      case "crew.status": {
        const { job_id } = args as { job_id: string };
        const result = await orchFetch<StatusResponse>("/status", {
          job_id,
        });

        const lines = [
          `Job ${result.job_id}: ${result.status} (${result.progress})`,
          "",
          ...result.subtasks.map((st) => {
            const parts = [
              `  ${st.id} [${st.status}] — ${st.description}`,
            ];
            if (st.result)
              parts.push(`    Result: ${st.result.slice(0, 200)}`);
            if (st.error)
              parts.push(`    Error: ${st.error.slice(0, 200)}`);
            return parts.join("\n");
          }),
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      case "crew.collect": {
        const { job_id } = args as { job_id: string };
        const result = await orchFetch<CollectResponse>("/collect", {
          job_id,
        });

        const lines = [
          `Job ${result.job_id}: ${result.status}`,
          `Progress: ${result.completed} completed, ${result.failed} failed, ${result.pending} pending`,
          "",
        ];

        for (const r of result.results) {
          lines.push(`--- ${r.subtask_id} [${r.status}] ---`);
          lines.push(`Task: ${r.description}`);
          if (r.result) lines.push(`Result: ${r.result}`);
          if (r.error) lines.push(`Error: ${r.error}`);
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      case "crew.cancel": {
        const { job_id } = args as { job_id: string };

        const workers = activeWorkers.get(job_id);
        if (workers) {
          for (const { proc, subtaskId } of workers) {
            try {
              proc.kill();
              log(`Killed worker ${subtaskId}`);
            } catch {}
          }
          activeWorkers.delete(job_id);
        }

        await orchFetch("/cancel", { job_id });
        return {
          content: [
            {
              type: "text" as const,
              text: `Job ${job_id} cancelled. ${workers?.length ?? 0} worker(s) killed.`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      isError: true,
    };
  }
});

// --- Startup ---

async function main() {
  if (IS_WORKER) {
    await mcp.connect(new StdioServerTransport());
    return;
  }

  await ensureOrchestrator();
  await mcp.connect(new StdioServerTransport());
  log("MCP connected (v1.0.0 — auto-spawn)");
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
