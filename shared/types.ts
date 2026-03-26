export type JobId = string;
export type SubtaskId = string;

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type SubtaskStatus = "pending" | "assigned" | "accepted" | "completed" | "failed" | "cancelled";
export type Strategy = "parallel";

export interface Job {
  id: JobId;
  leader_peer_id: string;
  task: string;
  strategy: Strategy;
  status: JobStatus;
  timeout_seconds: number;
  created_at: number;
  completed_at: number | null;
}

export interface Subtask {
  id: SubtaskId;
  job_id: JobId;
  description: string;
  files: string | null;      // JSON array stored as TEXT in SQLite
  assigned_peer_id: string | null;
  status: SubtaskStatus;
  result: string | null;
  error: string | null;
  created_at: number;
  assigned_at: number | null;
  completed_at: number | null;
}

export interface FileClaim {
  file_path: string;
  peer_id: string;
  subtask_id: SubtaskId;
  claimed_at: number;
  expires_at: number;
}

// --- Orchestrator API request/response types ---

export interface FanOutRequest {
  task: string;
  subtasks: Array<{
    description: string;
    files?: string[];
  }>;
  strategy?: Strategy;
  timeout_seconds?: number;
  context?: string;
  max_workers?: number;
  model?: string;
}

export interface FanOutResponse {
  job_id: JobId;
  assignments: Array<{
    subtask_id: SubtaskId;
    peer_id: string | null;
    status: SubtaskStatus;
  }>;
}

export interface StatusResponse {
  job_id: JobId;
  status: JobStatus;
  subtasks: Array<{
    id: SubtaskId;
    description: string;
    peer_id: string | null;
    status: SubtaskStatus;
    result: string | null;
    error: string | null;
  }>;
  progress: string;
}

export interface CollectResponse {
  job_id: JobId;
  status: JobStatus;
  results: Array<{
    subtask_id: SubtaskId;
    description: string;
    status: SubtaskStatus;
    result: string | null;
    error: string | null;
  }>;
  pending: number;
  completed: number;
  failed: number;
}

export interface ClaimFileResponse {
  claimed: boolean;
  held_by?: string;
}
