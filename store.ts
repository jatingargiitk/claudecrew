/**
 * Claude Crew SQLite store
 *
 * Manages jobs, subtasks, and file claims in a local SQLite database.
 */

import { Database } from "bun:sqlite";
import type { Job, Subtask, FileClaim, JobStatus, SubtaskStatus } from "./shared/types.ts";

const DB_PATH = process.env.CREW_DB ?? `${process.env.HOME}/.claudecrew.db`;

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

// --- Schema ---

db.run(`
  CREATE TABLE IF NOT EXISTS crew_jobs (
    id TEXT PRIMARY KEY,
    leader_peer_id TEXT NOT NULL,
    task TEXT NOT NULL,
    strategy TEXT NOT NULL DEFAULT 'parallel',
    status TEXT NOT NULL DEFAULT 'pending',
    timeout_seconds INTEGER NOT NULL DEFAULT 300,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS crew_subtasks (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES crew_jobs(id),
    description TEXT NOT NULL,
    files TEXT,
    assigned_peer_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    assigned_at INTEGER,
    completed_at INTEGER
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS crew_file_claims (
    file_path TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);

// --- ID generation ---

function generateId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Prepared statements ---

const insertJob = db.prepare(`
  INSERT INTO crew_jobs (id, leader_peer_id, task, strategy, status, timeout_seconds, created_at)
  VALUES (?, ?, ?, ?, 'pending', ?, ?)
`);

const insertSubtask = db.prepare(`
  INSERT INTO crew_subtasks (id, job_id, description, files, status, created_at)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);

const updateJobStatus = db.prepare(`
  UPDATE crew_jobs SET status = ?, completed_at = ? WHERE id = ?
`);

const updateSubtaskAssignment = db.prepare(`
  UPDATE crew_subtasks SET assigned_peer_id = ?, status = 'assigned', assigned_at = ? WHERE id = ?
`);

const updateSubtaskStatus = db.prepare(`
  UPDATE crew_subtasks SET status = ? WHERE id = ?
`);

const updateSubtaskResult = db.prepare(`
  UPDATE crew_subtasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?
`);

const updateSubtaskError = db.prepare(`
  UPDATE crew_subtasks SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
`);

const selectJob = db.prepare(`SELECT * FROM crew_jobs WHERE id = ?`);
const selectSubtasksByJob = db.prepare(`SELECT * FROM crew_subtasks WHERE job_id = ? ORDER BY created_at`);
const selectSubtask = db.prepare(`SELECT * FROM crew_subtasks WHERE id = ?`);
const selectAllJobs = db.prepare(`SELECT * FROM crew_jobs ORDER BY created_at DESC`);

const insertFileClaim = db.prepare(`
  INSERT OR REPLACE INTO crew_file_claims (file_path, peer_id, subtask_id, claimed_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
`);

const selectFileClaim = db.prepare(`SELECT * FROM crew_file_claims WHERE file_path = ?`);
const deleteFileClaim = db.prepare(`DELETE FROM crew_file_claims WHERE file_path = ?`);
const deleteFileClaimsBySubtask = db.prepare(`DELETE FROM crew_file_claims WHERE subtask_id = ?`);
const deleteExpiredClaims = db.prepare(`DELETE FROM crew_file_claims WHERE expires_at < ?`);

// --- Store API ---

export function createJob(
  leaderPeerId: string,
  task: string,
  strategy: string,
  timeoutSeconds: number,
): Job {
  const id = generateId("job_");
  const now = Date.now();
  insertJob.run(id, leaderPeerId, task, strategy, timeoutSeconds, now);
  return selectJob.get(id) as Job;
}

export function createSubtask(
  jobId: string,
  description: string,
  files: string[] | null,
): Subtask {
  const id = generateId("sub_");
  const now = Date.now();
  const filesJson = files ? JSON.stringify(files) : null;
  insertSubtask.run(id, jobId, description, filesJson, now);
  return selectSubtask.get(id) as Subtask;
}

export function assignSubtask(subtaskId: string, peerId: string): void {
  updateSubtaskAssignment.run(peerId, Date.now(), subtaskId);
}

export function acceptSubtask(subtaskId: string): Subtask | null {
  const subtask = selectSubtask.get(subtaskId) as Subtask | null;
  if (!subtask) return null;
  if (subtask.status !== "assigned" && subtask.status !== "pending") return subtask;
  updateSubtaskStatus.run("accepted", subtaskId);
  return selectSubtask.get(subtaskId) as Subtask;
}

export function completeSubtask(subtaskId: string, result: string): Subtask | null {
  const subtask = selectSubtask.get(subtaskId) as Subtask | null;
  if (!subtask) return null;
  updateSubtaskResult.run(result, Date.now(), subtaskId);
  deleteFileClaimsBySubtask.run(subtaskId);
  maybeCompleteJob(subtask.job_id);
  return selectSubtask.get(subtaskId) as Subtask;
}

export function failSubtask(subtaskId: string, error: string): Subtask | null {
  const subtask = selectSubtask.get(subtaskId) as Subtask | null;
  if (!subtask) return null;
  updateSubtaskError.run(error, Date.now(), subtaskId);
  deleteFileClaimsBySubtask.run(subtaskId);
  maybeCompleteJob(subtask.job_id);
  return selectSubtask.get(subtaskId) as Subtask;
}

export function cancelJob(jobId: string): void {
  const now = Date.now();
  updateJobStatus.run("cancelled" satisfies JobStatus, now, jobId);
  const subtasks = selectSubtasksByJob.all(jobId) as Subtask[];
  for (const st of subtasks) {
    if (st.status === "pending" || st.status === "assigned" || st.status === "accepted") {
      updateSubtaskStatus.run("cancelled" satisfies SubtaskStatus, st.id);
      deleteFileClaimsBySubtask.run(st.id);
    }
  }
}

export function setJobRunning(jobId: string): void {
  updateJobStatus.run("running" satisfies JobStatus, null, jobId);
}

function maybeCompleteJob(jobId: string): void {
  const subtasks = selectSubtasksByJob.all(jobId) as Subtask[];
  const allDone = subtasks.every(
    (st) => st.status === "completed" || st.status === "failed" || st.status === "cancelled",
  );
  if (!allDone) return;

  const anyFailed = subtasks.some((st) => st.status === "failed");
  const allCancelled = subtasks.every((st) => st.status === "cancelled");

  let status: JobStatus;
  if (allCancelled) status = "cancelled";
  else if (anyFailed) status = "failed";
  else status = "completed";

  updateJobStatus.run(status, Date.now(), jobId);
}

export function getJob(jobId: string): Job | null {
  return selectJob.get(jobId) as Job | null;
}

export function getSubtasksByJob(jobId: string): Subtask[] {
  return selectSubtasksByJob.all(jobId) as Subtask[];
}

export function getSubtask(subtaskId: string): Subtask | null {
  return selectSubtask.get(subtaskId) as Subtask | null;
}

export function getAllJobs(): Job[] {
  return selectAllJobs.all() as Job[];
}

export function claimFile(
  filePath: string,
  peerId: string,
  subtaskId: string,
  timeoutSeconds: number,
): { claimed: boolean; held_by?: string } {
  cleanExpiredClaims();
  const existing = selectFileClaim.get(filePath) as FileClaim | null;
  if (existing && existing.peer_id !== peerId) {
    return { claimed: false, held_by: existing.peer_id };
  }
  const now = Date.now();
  insertFileClaim.run(filePath, peerId, subtaskId, now, now + timeoutSeconds * 1000);
  return { claimed: true };
}

export function releaseFile(filePath: string): void {
  deleteFileClaim.run(filePath);
}

export function cleanExpiredClaims(): void {
  deleteExpiredClaims.run(Date.now());
}

export function cleanTimedOutSubtasks(): void {
  const jobs = selectAllJobs.all() as Job[];
  const now = Date.now();
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const deadline = job.created_at + job.timeout_seconds * 1000;
    if (now <= deadline) continue;

    const subtasks = selectSubtasksByJob.all(job.id) as Subtask[];
    for (const st of subtasks) {
      if (st.status === "assigned" || st.status === "accepted") {
        updateSubtaskError.run("Timed out", now, st.id);
        deleteFileClaimsBySubtask.run(st.id);
      }
    }
    maybeCompleteJob(job.id);
  }
}

export { DB_PATH };
