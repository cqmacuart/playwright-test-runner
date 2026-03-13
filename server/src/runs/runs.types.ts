import { ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export type RunMode = "sequential" | "parallel";
export type RunItemStatus = "queued" | "running" | "success" | "failed" | "stopped";

export type RunItem = {
  itemId: string;
  testFile: string;
  status: RunItemStatus;
  exitCode: number | null;
  startedAt?: string;
  finishedAt?: string;
  process?: ChildProcessWithoutNullStreams;
};

export type Run = {
  runId: string;
  mode: RunMode;
  parallelism: number;
  items: RunItem[];
  queue: RunItem[];
  active: Map<string, RunItem>;
  stopped: boolean;
  completed: boolean;
  emitter: EventEmitter;
};

export type RunEvent =
  | { type: "run_started"; runId: string }
  | { type: "item_started"; runId: string; itemId: string; testFile: string }
  | {
      type: "stdout" | "stderr";
      runId: string;
      itemId: string;
      testFile: string;
      chunk: string;
    }
  | {
      type: "item_finished";
      runId: string;
      itemId: string;
      testFile: string;
      status: RunItemStatus;
      exitCode: number | null;
    }
  | { type: "run_finished"; runId: string; stopped: boolean };
