#!/usr/bin/env bun
/**
 * Claude Crew CLI
 *
 * Usage:
 *   bun cli.ts init                — Set up .mcp.json in current directory
 *   bun cli.ts up                  — Start orchestrator daemon
 *   bun cli.ts down                — Stop orchestrator daemon
 *   bun cli.ts status              — Show orchestrator status
 *   bun cli.ts jobs                — List all jobs
 *   bun cli.ts job <job_id>        — Show detailed job status
 *   bun cli.ts cancel <job_id>     — Cancel a job
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const ORCH_PORT = parseInt(process.env.CREW_PORT ?? "7900", 10);
const ORCH_URL = `http://127.0.0.1:${ORCH_PORT}`;

const CREW_DIR = new URL(".", import.meta.url).pathname;
const ORCH_SCRIPT = resolve(CREW_DIR, "orchestrator.ts");
const SERVER_SCRIPT = resolve(CREW_DIR, "server.ts");

async function orchFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${ORCH_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function isAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const cmd = process.argv[2];

switch (cmd) {
  // ─── crew init ──────────────────────────────────────
  case "init": {
    const cwd = process.cwd();
    const mcpPath = resolve(cwd, ".mcp.json");

    const mcpConfig = {
      mcpServers: {
        "claudecrew": {
          command: "/bin/zsh",
          args: ["-lc", `exec bun ${SERVER_SCRIPT}`],
        },
      },
    };

    if (existsSync(mcpPath)) {
      try {
        const existing = JSON.parse(readFileSync(mcpPath, "utf-8"));
        existing.mcpServers = {
          ...existing.mcpServers,
          ...mcpConfig.mcpServers,
        };
        writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
        console.log(`Updated ${mcpPath} with claudecrew server.`);
      } catch {
        writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
        console.log(`Created ${mcpPath}`);
      }
    } else {
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
      console.log(`Created ${mcpPath}`);
    }

    console.log(`\nDone! Now run:\n`);
    console.log(`  claude`);
    console.log(`  Then ask: "Use Claude Crew to <your task>"\n`);
    console.log(`Workers spawn automatically — no extra terminals needed.`);
    break;
  }

  // ─── crew up ────────────────────────────────────────
  case "up": {
    console.log("Starting Claude Crew...\n");

    if (await isAlive(ORCH_URL)) {
      console.log("  [ok] Orchestrator already running");
    } else {
      console.log("  [..] Starting orchestrator...");
      const proc = Bun.spawn(["bun", ORCH_SCRIPT], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (await isAlive(ORCH_URL)) break;
      }
      if (await isAlive(ORCH_URL)) {
        console.log(`  [ok] Orchestrator started on :${ORCH_PORT}`);
      } else {
        console.error("  [!!] Failed to start orchestrator");
        process.exit(1);
      }
    }

    console.log("\n────────────────────────────────────────────");
    console.log("Claude Crew is running!\n");
    console.log("Just open one terminal and run:");
    console.log(`  $ claude`);
    console.log(`  Then ask: "Use Claude Crew to <your task>"\n`);
    console.log("Workers spawn automatically — no extra terminals needed.");
    console.log("────────────────────────────────────────────");
    break;
  }

  // ─── crew down ──────────────────────────────────────
  case "down": {
    console.log("Stopping Claude Crew...\n");

    try {
      const proc = Bun.spawnSync(["lsof", "-ti", `:${ORCH_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) process.kill(parseInt(pid), "SIGTERM");
      console.log("  [ok] Orchestrator stopped");
    } catch {
      console.log("  [--] Orchestrator was not running");
    }

    console.log("\nDone.");
    break;
  }

  // ─── crew status ────────────────────────────────────
  case "status": {
    try {
      const orch = await isAlive(ORCH_URL);
      console.log(
        `Orchestrator: ${orch ? "running" : "stopped"} (:${ORCH_PORT})`,
      );

      if (orch) {
        const health = await orchFetch<{ jobs: number; running: number }>(
          "/health",
        );
        console.log(
          `Jobs:         ${health.jobs} total, ${health.running} running`,
        );
      }
    } catch {
      console.log("Could not connect to orchestrator.");
    }
    break;
  }

  // ─── crew jobs ──────────────────────────────────────
  case "jobs": {
    try {
      const jobs = await orchFetch<
        Array<{
          id: string;
          task: string;
          status: string;
          created_at: number;
        }>
      >("/jobs", {});
      if (jobs.length === 0) {
        console.log("No jobs.");
      } else {
        for (const j of jobs) {
          const age = Math.round((Date.now() - j.created_at) / 1000);
          console.log(
            `${j.id}  [${j.status}]  ${age}s ago  ${j.task.slice(0, 60)}`,
          );
        }
      }
    } catch {
      console.log("Orchestrator is not running. Run: crew up");
    }
    break;
  }

  // ─── crew job <id> ──────────────────────────────────
  case "job": {
    const jobId = process.argv[3];
    if (!jobId) {
      console.error("Usage: crew job <job_id>");
      process.exit(1);
    }
    try {
      const status = await orchFetch<{
        job_id: string;
        status: string;
        progress: string;
        subtasks: Array<{
          id: string;
          description: string;
          peer_id: string | null;
          status: string;
          result: string | null;
          error: string | null;
        }>;
      }>("/status", { job_id: jobId });
      console.log(
        `Job: ${status.job_id}  [${status.status}]  ${status.progress}`,
      );
      for (const st of status.subtasks) {
        console.log(`  ${st.id} [${st.status}]  ${st.description.slice(0, 50)}`);
        if (st.result) console.log(`    Result: ${st.result.slice(0, 80)}`);
        if (st.error) console.log(`    Error: ${st.error.slice(0, 80)}`);
      }
    } catch (e) {
      console.error(
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    break;
  }

  // ─── crew cancel <id> ───────────────────────────────
  case "cancel": {
    const jobId = process.argv[3];
    if (!jobId) {
      console.error("Usage: crew cancel <job_id>");
      process.exit(1);
    }
    try {
      await orchFetch("/cancel", { job_id: jobId });
      console.log(`Job ${jobId} cancelled.`);
    } catch (e) {
      console.error(
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    break;
  }

  // ─── help ───────────────────────────────────────────
  default:
    console.log(`Claude Crew CLI

Setup:
  crew init              Set up .mcp.json in current directory
  crew up                Start orchestrator daemon
  crew down              Stop orchestrator daemon

Monitor:
  crew status            Show service status
  crew jobs              List all jobs
  crew job <job_id>      Show detailed job status
  crew cancel <job_id>   Cancel a job

Workflow:
  1. crew init           (one-time per project)
  2. claude              (open one terminal)
  3. "Use Claude Crew to refactor all endpoints"
  4. Workers spawn automatically — no extra terminals!`);
}
