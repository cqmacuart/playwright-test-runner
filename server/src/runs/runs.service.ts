import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { killProcessTree } from "../common/process-utils";
import { ensureInsideRoot, normalizeRelative } from "../common/path-utils";
import { WorkspaceService } from "../workspace/workspace.service";
import { CreateRunDto } from "./dto/create-run.dto";
import { Run, RunEvent, RunItem, RunItemStatus } from "./runs.types";

@Injectable()
export class RunsService {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly workspaceService: WorkspaceService) {}

  createRun(body: CreateRunDto): { runId: string; mode: string; parallelism: number; items: RunItem[] } {
    const root = this.workspaceService.getWorkspaceRoot();
    const mode = body.mode;
    const parallelism = mode === "sequential" ? 1 : body.parallelism ?? 2;
    const testFiles = [...new Set(body.testFiles.map((entry) => normalizeRelative(entry)))];
    if (!testFiles.length) {
      throw new BadRequestException("No se recibieron pruebas para ejecutar.");
    }

    const items: RunItem[] = testFiles.map((testFile) => {
      const absolutePath = this.workspaceService.resolveAbsolute(testFile);
      if (!ensureInsideRoot(root, absolutePath)) {
        throw new BadRequestException(`Ruta fuera del workspace: ${testFile}`);
      }
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new BadRequestException(`Archivo no válido: ${testFile}`);
      }

      return {
        itemId: randomUUID(),
        testFile,
        status: "queued",
        exitCode: null,
      };
    });

    const runId = randomUUID();
    const run: Run = {
      runId,
      mode,
      parallelism,
      items,
      queue: [...items],
      active: new Map<string, RunItem>(),
      stopped: false,
      completed: false,
      emitter: new EventEmitter(),
    };
    this.runs.set(runId, run);
    setImmediate(() => {
      this.emit(run, { type: "run_started", runId });
      this.pump(runId).catch(() => {
        this.stopRun(runId).catch(() => undefined);
      });
    });

    return { runId, mode, parallelism, items };
  }

  getRun(runId: string): { runId: string; mode: string; parallelism: number; stopped: boolean; items: RunItem[] } {
    const run = this.mustGetRun(runId);
    return {
      runId: run.runId,
      mode: run.mode,
      parallelism: run.parallelism,
      stopped: run.stopped,
      items: run.items,
    };
  }

  getEmitter(runId: string): EventEmitter {
    return this.mustGetRun(runId).emitter;
  }

  async stopRun(runId: string): Promise<void> {
    const run = this.mustGetRun(runId);
    run.stopped = true;

    for (const queued of run.queue) {
      queued.status = "stopped";
      queued.finishedAt = new Date().toISOString();
      this.emit(run, {
        type: "item_finished",
        runId,
        itemId: queued.itemId,
        testFile: queued.testFile,
        status: queued.status,
        exitCode: null,
      });
    }
    run.queue = [];

    await Promise.all(
      Array.from(run.active.values()).map(async (item) => {
        if (!item.process?.pid) return;
        await killProcessTree(item.process.pid);
      })
    );
  }

  async stopRunItem(runId: string, itemId: string): Promise<void> {
    const run = this.mustGetRun(runId);
    const activeItem = run.active.get(itemId);
    if (activeItem?.process?.pid) {
      await killProcessTree(activeItem.process.pid);
      return;
    }

    const queuedItem = run.queue.find((entry) => entry.itemId === itemId);
    if (!queuedItem) {
      throw new NotFoundException("Item no encontrado en ejecución.");
    }
    queuedItem.status = "stopped";
    queuedItem.finishedAt = new Date().toISOString();
    run.queue = run.queue.filter((entry) => entry.itemId !== itemId);
    this.emit(run, {
      type: "item_finished",
      runId,
      itemId: queuedItem.itemId,
      testFile: queuedItem.testFile,
      status: queuedItem.status,
      exitCode: null,
    });
  }

  private async pump(runId: string): Promise<void> {
    const run = this.mustGetRun(runId);
    if (run.completed) return;

    while (!run.stopped && run.active.size < run.parallelism && run.queue.length > 0) {
      const item = run.queue.shift()!;
      if (item.status === "stopped") {
        continue;
      }
      this.startItem(run, item);
    }

    if ((run.stopped || run.queue.length === 0) && run.active.size === 0 && !run.completed) {
      run.completed = true;
      this.emit(run, { type: "run_finished", runId: run.runId, stopped: run.stopped });
      setTimeout(() => this.runs.delete(run.runId), 5 * 60 * 1000);
    }
  }

  private startItem(run: Run, item: RunItem): void {
    const workspaceRoot = this.workspaceService.getWorkspaceRoot();
    const absolutePath = this.workspaceService.resolveAbsolute(item.testFile);
    const relativePath = normalizeRelative(path.relative(workspaceRoot, absolutePath));
    const isWindows = process.platform === "win32";
    const localBin = path.join(
      workspaceRoot,
      "node_modules",
      ".bin",
      isWindows ? "playwright.cmd" : "playwright"
    );
    const command = fs.existsSync(localBin) ? localBin : isWindows ? "npx.cmd" : "npx";
    const args = fs.existsSync(localBin)
      ? ["test", relativePath]
      : ["playwright", "test", relativePath];

    item.status = "running";
    item.startedAt = new Date().toISOString();
    run.active.set(item.itemId, item);

    this.emit(run, {
      type: "item_started",
      runId: run.runId,
      itemId: item.itemId,
      testFile: item.testFile,
    });

    const child = spawn(command, args, {
      cwd: workspaceRoot,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    item.process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.emit(run, {
        type: "stdout",
        runId: run.runId,
        itemId: item.itemId,
        testFile: item.testFile,
        chunk: chunk.toString(),
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.emit(run, {
        type: "stderr",
        runId: run.runId,
        itemId: item.itemId,
        testFile: item.testFile,
        chunk: chunk.toString(),
      });
    });

    child.on("close", (code) => {
      run.active.delete(item.itemId);
      item.exitCode = code;
      item.finishedAt = new Date().toISOString();
      item.status = this.resolveStatus(item.status, code);
      this.emit(run, {
        type: "item_finished",
        runId: run.runId,
        itemId: item.itemId,
        testFile: item.testFile,
        status: item.status,
        exitCode: code,
      });
      void this.pump(run.runId);
    });
  }

  private resolveStatus(current: RunItemStatus, exitCode: number | null): RunItemStatus {
    if (current === "stopped") return "stopped";
    return exitCode === 0 ? "success" : "failed";
  }

  private emit(run: Run, event: RunEvent): void {
    run.emitter.emit("event", event);
  }

  private mustGetRun(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundException("Run no encontrado.");
    }
    return run;
  }
}
