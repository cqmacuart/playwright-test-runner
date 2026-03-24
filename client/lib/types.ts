export type TreeNode = {
  name: string;
  type: "file" | "folder";
  relativePath: string;
  hasChildren?: boolean;
};

export type RunMode = "sequential" | "parallel";

export type RunItemStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "stopped";

export type RunItem = {
  itemId: string;
  testFile: string;
  status: RunItemStatus;
  exitCode: number | null;
  startedAt?: string;
  finishedAt?: string;
};

export type RunCreated = {
  runId: string;
  mode: RunMode;
  parallelism: number;
  items: RunItem[];
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
  | { type: "report_merging"; runId: string }
  | { type: "run_finished"; runId: string; stopped: boolean; reportPath?: string };

export type BrowserItem = {
  name: string;
  type: "folder" | "drive";
  path: string;
};
