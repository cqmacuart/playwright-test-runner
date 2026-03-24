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
  /** Si está definido, la ejecución es un único proceso Playwright con informe HTML unificado. */
  reportStoragePath?: string;
  tmpReportDir?: string;
  batchProcess?: ChildProcessWithoutNullStreams;
  /** Solo ejecución unificada en modo secuencial: ítem activo y buffer de líneas para detectar cambio de archivo. */
  unifiedSeq?: { activeIndex: number; carry: string };
  /** Ejecución unificada en paralelo: pool de archivos “en curso” y cola esperando hueco (como hilos). */
  unifiedParallel?: { carry: string; runningPool: Set<number>; fileQueue: number[] };
  /** Conteo de tests por archivo (desde `playwright test --list`) para cerrar ítems al completar cada archivo. */
  unifiedProgress?: {
    expected: number[];
    completed: number[];
    anyFailed: boolean[];
    finished: Set<number>;
  };
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
  | { type: "run_finished"; runId: string; stopped: boolean; reportPath?: string };
