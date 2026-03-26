#!/usr/bin/env bun
/**
 * Claude Crew orchestrator daemon
 *
 * HTTP server on localhost:7900 — SQLite-backed state store for jobs,
 * subtasks, and file claims. Auto-launched by the MCP server.
 */

import {
  createJob,
  createSubtask,
  acceptSubtask,
  completeSubtask,
  failSubtask,
  cancelJob,
  setJobRunning,
  getJob,
  getSubtasksByJob,
  getSubtask,
  getAllJobs,
  claimFile,
  releaseFile,
  cleanTimedOutSubtasks,
  cleanExpiredClaims,
  DB_PATH,
} from "./store.ts";
import type {
  FanOutRequest,
  FanOutResponse,
  StatusResponse,
  CollectResponse,
  ClaimFileResponse,
  Subtask,
  Job,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CREW_PORT ?? "7900", 10);

// --- Request handlers ---

function handleFanOut(body: FanOutRequest): FanOutResponse {
  const timeoutSeconds = body.timeout_seconds ?? 300;
  const job = createJob("leader", body.task, "parallel", timeoutSeconds);

  const assignments: FanOutResponse["assignments"] = [];
  for (const st of body.subtasks) {
    const subtask = createSubtask(job.id, st.description, st.files ?? null);
    assignments.push({
      subtask_id: subtask.id,
      peer_id: null,
      status: "pending",
    });
  }

  setJobRunning(job.id);
  return { job_id: job.id, assignments };
}

function handleStatus(jobId: string): StatusResponse | null {
  const job = getJob(jobId);
  if (!job) return null;

  const subtasks = getSubtasksByJob(jobId);
  const completed = subtasks.filter((st) => st.status === "completed").length;
  const total = subtasks.length;

  return {
    job_id: job.id,
    status: job.status as Job["status"],
    subtasks: subtasks.map((st) => ({
      id: st.id,
      description: st.description,
      peer_id: st.assigned_peer_id,
      status: st.status as Subtask["status"],
      result: st.result,
      error: st.error,
    })),
    progress: `${completed}/${total} complete`,
  };
}

function handleCollect(jobId: string): CollectResponse | null {
  const job = getJob(jobId);
  if (!job) return null;

  const subtasks = getSubtasksByJob(jobId);
  const completed = subtasks.filter((st) => st.status === "completed").length;
  const failed = subtasks.filter((st) => st.status === "failed").length;
  const pending = subtasks.filter(
    (st) =>
      st.status === "pending" ||
      st.status === "assigned" ||
      st.status === "accepted",
  ).length;

  return {
    job_id: job.id,
    status: job.status as Job["status"],
    results: subtasks.map((st) => ({
      subtask_id: st.id,
      description: st.description,
      status: st.status as Subtask["status"],
      result: st.result,
      error: st.error,
    })),
    pending,
    completed,
    failed,
  };
}

function handleCancel(jobId: string): void {
  cancelJob(jobId);
}

function handleAccept(subtaskId: string): { ok: boolean; error?: string } {
  const subtask = getSubtask(subtaskId);
  if (!subtask) return { ok: false, error: `Subtask ${subtaskId} not found` };
  acceptSubtask(subtaskId);
  return { ok: true };
}

function handleComplete(body: {
  subtask_id: string;
  result: string;
  files_changed?: string[];
}): { ok: boolean; error?: string } {
  const result = body.files_changed
    ? `${body.result}\n\nFiles changed: ${body.files_changed.join(", ")}`
    : body.result;
  const subtask = completeSubtask(body.subtask_id, result);
  if (!subtask)
    return { ok: false, error: `Subtask ${body.subtask_id} not found` };
  return { ok: true };
}

function handleFail(body: {
  subtask_id: string;
  error: string;
}): { ok: boolean; error?: string } {
  const subtask = failSubtask(body.subtask_id, body.error);
  if (!subtask)
    return { ok: false, error: `Subtask ${body.subtask_id} not found` };
  return { ok: true };
}

function handleClaimFile(body: {
  file: string;
  subtask_id: string;
  peer_id: string;
}): ClaimFileResponse {
  const job = (() => {
    const st = getSubtask(body.subtask_id);
    return st ? getJob(st.job_id) : null;
  })();
  const timeout = job?.timeout_seconds ?? 300;
  return claimFile(body.file, body.peer_id, body.subtask_id, timeout);
}

function handleReleaseFile(body: { file: string }): { ok: boolean } {
  releaseFile(body.file);
  return { ok: true };
}

function handleListJobs(): Job[] {
  return getAllJobs();
}

// --- Periodic cleanup ---

setInterval(() => {
  cleanTimedOutSubtasks();
  cleanExpiredClaims();
}, 10_000);

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        const jobs = getAllJobs();
        const running = jobs.filter((j) => j.status === "running").length;
        return Response.json({ status: "ok", jobs: jobs.length, running });
      }
      return new Response("claudecrew orchestrator", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/fan-out":
          return Response.json(handleFanOut(body as FanOutRequest));
        case "/status": {
          const result = handleStatus(
            (body as { job_id: string }).job_id,
          );
          if (!result)
            return Response.json(
              { error: "Job not found" },
              { status: 404 },
            );
          return Response.json(result);
        }
        case "/collect": {
          const result = handleCollect(
            (body as { job_id: string }).job_id,
          );
          if (!result)
            return Response.json(
              { error: "Job not found" },
              { status: 404 },
            );
          return Response.json(result);
        }
        case "/cancel":
          handleCancel((body as { job_id: string }).job_id);
          return Response.json({ ok: true });
        case "/accept":
          return Response.json(
            handleAccept((body as { subtask_id: string }).subtask_id),
          );
        case "/complete":
          return Response.json(
            handleComplete(
              body as {
                subtask_id: string;
                result: string;
                files_changed?: string[];
              },
            ),
          );
        case "/fail":
          return Response.json(
            handleFail(body as { subtask_id: string; error: string }),
          );
        case "/claim-file":
          return Response.json(
            handleClaimFile(
              body as { file: string; subtask_id: string; peer_id: string },
            ),
          );
        case "/release-file":
          return Response.json(
            handleReleaseFile(body as { file: string }),
          );
        case "/jobs":
          return Response.json(handleListJobs());
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(
  `[claudecrew] orchestrator listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`,
);
