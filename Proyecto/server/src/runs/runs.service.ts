import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { spawn } from "child_process";
import { execFile } from "child_process/promises";
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

    const reportStoragePath = body.reportStoragePath
      ? this.resolveAndValidateReportDir(body.reportStoragePath)
      : undefined;

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
      queue: reportStoragePath ? [] : [...items],
      active: new Map<string, RunItem>(),
      stopped: false,
      completed: false,
      emitter: new EventEmitter(),
      reportStoragePath,
    };
    this.runs.set(runId, run);
    setTimeout(() => {
      this.emit(run, { type: "run_started", runId });
      if (reportStoragePath) {
        void this.startUnifiedRun(runId).catch(() => {
          void this.stopRun(runId).catch(() => undefined);
        });
      } else {
        void this.pump(runId).catch(() => {
          void this.stopRun(runId).catch(() => undefined);
        });
      }
    }, 300);

    return { runId, mode, parallelism, items };
  }

  private resolveAndValidateReportDir(input: string): string {
    const resolved = path.resolve(input.trim());
    if (!fs.existsSync(resolved)) {
      throw new BadRequestException("La carpeta de reportes no existe.");
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new BadRequestException("La ruta de reportes debe ser un directorio.");
    }
    return resolved;
  }

  private formatReportFolderName(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `Test_Suite_${y}-${m}-${d}_${h}-${min}-${s}`;
  }

  private async fetchExpectedTestCountsPerFile(workspaceRoot: string, relativePaths: string[]): Promise<number[]> {
    const isWindows = process.platform === "win32";
    const localBin = path.join(
      workspaceRoot,
      "node_modules",
      ".bin",
      isWindows ? "playwright.cmd" : "playwright"
    );
    const cmd = fs.existsSync(localBin) ? localBin : isWindows ? "npx.cmd" : "npx";
    const args = fs.existsSync(localBin)
      ? ["test", ...relativePaths, "--list"]
      : ["playwright", "test", ...relativePaths, "--list"];
    try {
      const { stdout } = await execFile(cmd, args, {
        cwd: workspaceRoot,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        shell: isWindows,
      });
      return this.parseListOutputTestCounts(stdout, relativePaths);
    } catch {
      return relativePaths.map(() => 1);
    }
  }

  /** Cuenta líneas de `playwright test --list` por archivo (incluye proyectos/navegadores). */
  private parseListOutputTestCounts(stdout: string, relativePaths: string[]): number[] {
    const counts = new Array(relativePaths.length).fill(0);
    const normalizedItems = relativePaths.map((p) => normalizeRelative(p).replace(/\\/g, "/").toLowerCase());
    let inListing = false;
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.includes("Listing tests")) {
        inListing = true;
        continue;
      }
      if (!inListing || !line) {
        continue;
      }
      const m = line.match(/›\s*(.+?\.(?:spec|test)\.ts)/i);
      if (!m) {
        continue;
      }
      const filePart = m[1].trim().replace(/\\/g, "/").toLowerCase();
      let matched = -1;
      for (let i = 0; i < relativePaths.length; i++) {
        const rel = normalizedItems[i];
        if (filePart === rel || filePart.endsWith("/" + rel)) {
          matched = i;
          break;
        }
      }
      if (matched === -1) {
        for (let i = 0; i < relativePaths.length; i++) {
          const base = path.basename(relativePaths[i]).toLowerCase();
          if (base && filePart.endsWith(base)) {
            matched = i;
            break;
          }
        }
      }
      if (matched >= 0) {
        counts[matched]++;
      }
    }
    return counts;
  }

  private isPlaywrightTestResultLine(line: string): boolean {
    const t = line.trim();
    if (/^Running\s+\d+\s+tests?/i.test(t)) {
      return false;
    }
    if (t.includes("›") && (/\d+\s*ms\)|\(\d+\.?\d*s\)\s*$/.test(t) || /^\s*\d+\)/.test(t) || /^\s*[✓✔✘☓✖]/.test(t))) {
      return true;
    }
    if (/^\s*\d+\)/.test(t) && (t.includes(".spec.ts") || t.includes(".test.ts"))) {
      return true;
    }
    if (/^\s*[✓✔✘☓✖]/.test(t) && (t.includes(".spec.ts") || t.includes(".test.ts"))) {
      return true;
    }
    return false;
  }

  private resultLineIndicatesFail(line: string): boolean {
    const t = line.trim();
    if (/[✘☓✖]/.test(t)) {
      return true;
    }
    if (/\bfail(?:ed|ure)?\b/i.test(t) && t.includes(".ts")) {
      return true;
    }
    return false;
  }

  private matchLineToBestFileIndex(line: string, items: RunItem[]): number | null {
    const lower = line.toLowerCase();
    let best: { idx: number; score: number } | null = null;
    for (let i = 0; i < items.length; i++) {
      const rel = normalizeRelative(items[i].testFile).replace(/\\/g, "/");
      const base = path.basename(items[i].testFile).toLowerCase();
      if (!base || !lower.includes(base)) {
        continue;
      }
      const score = rel.length;
      if (!best || score > best.score) {
        best = { idx: i, score };
      }
    }
    return best?.idx ?? null;
  }

  private ensureQueuedMarkedStarted(
    run: Run,
    idx: number,
    startedAt: string,
    parallel?: NonNullable<Run["unifiedParallel"]>
  ): void {
    const item = run.items[idx];
    if (item.status !== "queued") {
      return;
    }
    item.status = "running";
    item.startedAt = startedAt;
    if (parallel) {
      const q = parallel.fileQueue.indexOf(idx);
      if (q >= 0) {
        parallel.fileQueue.splice(q, 1);
      }
      parallel.runningPool.add(idx);
    }
    this.emit(run, {
      type: "item_started",
      runId: run.runId,
      itemId: item.itemId,
      testFile: item.testFile,
    });
  }

  private emitFileFinishedForItem(
    run: Run,
    idx: number,
    status: RunItemStatus | null,
    progress: NonNullable<Run["unifiedProgress"]>
  ): void {
    if (progress.finished.has(idx)) {
      return;
    }
    const now = new Date().toISOString();
    const item = run.items[idx];
    const st: RunItemStatus = status ?? (progress.anyFailed[idx] ? "failed" : "success");
    item.status = st;
    item.finishedAt = now;
    progress.finished.add(idx);
    run.unifiedParallel?.runningPool.delete(idx);
    this.emit(run, {
      type: "item_finished",
      runId: run.runId,
      itemId: item.itemId,
      testFile: item.testFile,
      status: st,
      exitCode: null,
    });
  }

  private async startUnifiedRun(runId: string): Promise<void> {
    const run = this.mustGetRun(runId);
    if (run.completed || run.stopped || !run.reportStoragePath) {
      return;
    }

    const workspaceRoot = this.workspaceService.getWorkspaceRoot();
    const tmpDir = path.join(run.reportStoragePath, `.pw-html-${runId}`);
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const item of run.items) {
        this.emit(run, {
          type: "stderr",
          runId: run.runId,
          itemId: item.itemId,
          testFile: item.testFile,
          chunk: `No se pudo preparar la carpeta del informe: ${msg}\n`,
        });
      }
      this.finalizeUnifiedRun(run, 1);
      return;
    }

    run.tmpReportDir = tmpDir;

    const relativePaths = run.items.map((entry) => normalizeRelative(entry.testFile));
    const expectedCounts = await this.fetchExpectedTestCountsPerFile(workspaceRoot, relativePaths);
    const n = run.items.length;
    run.unifiedProgress = {
      expected: expectedCounts.map((c) => Math.max(1, c)),
      completed: new Array(n).fill(0),
      anyFailed: new Array(n).fill(false),
      finished: new Set<number>(),
    };

    const startedAt = new Date().toISOString();
    if (run.mode === "sequential" && run.items.length > 0) {
      run.unifiedSeq = { activeIndex: 0, carry: "" };
      const first = run.items[0];
      first.status = "running";
      first.startedAt = startedAt;
      for (let i = 1; i < run.items.length; i++) {
        run.items[i].status = "queued";
      }
      this.emit(run, {
        type: "item_started",
        runId: run.runId,
        itemId: first.itemId,
        testFile: first.testFile,
      });
    } else {
      const w = Math.min(Math.max(1, run.parallelism), run.items.length);
      const runningPool = new Set<number>();
      const fileQueue: number[] = [];
      for (let i = 0; i < run.items.length; i++) {
        if (i < w) {
          runningPool.add(i);
        } else {
          fileQueue.push(i);
        }
      }
      run.unifiedParallel = { carry: "", runningPool, fileQueue };
      for (let i = 0; i < run.items.length; i++) {
        const item = run.items[i];
        if (runningPool.has(i)) {
          item.status = "running";
          item.startedAt = startedAt;
          this.emit(run, {
            type: "item_started",
            runId: run.runId,
            itemId: item.itemId,
            testFile: item.testFile,
          });
        } else {
          item.status = "queued";
        }
      }
    }

    const isWindows = process.platform === "win32";
    const localBin = path.join(
      workspaceRoot,
      "node_modules",
      ".bin",
      isWindows ? "playwright.cmd" : "playwright"
    );
    const command = fs.existsSync(localBin) ? localBin : isWindows ? "npx.cmd" : "npx";
    const workers = run.mode === "sequential" ? 1 : run.parallelism;
    const reporterArgs = ["--reporter=line", "--reporter=html", `--workers=${workers}`];
    const args = fs.existsSync(localBin)
      ? ["test", ...relativePaths, ...reporterArgs]
      : ["playwright", "test", ...relativePaths, ...reporterArgs];

    const env = {
      ...process.env,
      PLAYWRIGHT_HTML_OUTPUT_DIR: tmpDir,
    };

    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: isWindows,
    });
    run.batchProcess = child;

    const broadcastAll = (type: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      for (const item of run.items) {
        this.emit(run, {
          type,
          runId: run.runId,
          itemId: item.itemId,
          testFile: item.testFile,
          chunk: text,
        });
      }
    };

    const broadcastSequential = (type: "stdout" | "stderr", chunk: Buffer) => {
      const state = run.unifiedSeq;
      if (!state) {
        broadcastAll(type, chunk);
        return;
      }
      state.carry += chunk.toString();
      for (;;) {
        const nl = state.carry.indexOf("\n");
        if (nl === -1) {
          break;
        }
        const raw = state.carry.slice(0, nl);
        state.carry = state.carry.slice(nl + 1);
        const line = raw.replace(/\r$/, "");
        this.emitUnifiedSequentialLine(run, state, line, type);
      }
    };

    const broadcastParallel = (type: "stdout" | "stderr", chunk: Buffer) => {
      const state = run.unifiedParallel;
      if (!state) {
        broadcastAll(type, chunk);
        return;
      }
      state.carry += chunk.toString();
      for (;;) {
        const nl = state.carry.indexOf("\n");
        if (nl === -1) {
          break;
        }
        const raw = state.carry.slice(0, nl);
        state.carry = state.carry.slice(nl + 1);
        const line = raw.replace(/\r$/, "");
        this.emitUnifiedParallelLine(run, state, line, type);
      }
    };

    const onOut =
      run.mode === "sequential" && run.items.length > 0 && run.unifiedSeq
        ? broadcastSequential
        : run.mode === "parallel" && run.items.length > 0 && run.unifiedParallel
          ? broadcastParallel
          : broadcastAll;
    child.stdout.on("data", (chunk: Buffer) => onOut("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onOut("stderr", chunk));

    child.on("error", (error: Error) => {
      for (const item of run.items) {
        this.emit(run, {
          type: "stderr",
          runId: run.runId,
          itemId: item.itemId,
          testFile: item.testFile,
          chunk: `Error de ejecución: ${error.message}\n`,
        });
      }
      this.finalizeUnifiedRun(run, 1);
    });

    child.on("close", (code) => {
      if (run.completed) {
        return;
      }
      if (run.unifiedSeq?.carry && run.mode === "sequential") {
        const rest = run.unifiedSeq.carry.replace(/\r$/, "");
        if (rest.length) {
          this.emitUnifiedSequentialLine(run, run.unifiedSeq, rest, "stdout");
        }
        run.unifiedSeq.carry = "";
      }
      if (run.unifiedParallel?.carry && run.mode === "parallel") {
        const rest = run.unifiedParallel.carry.replace(/\r$/, "");
        if (rest.length) {
          this.emitUnifiedParallelLine(run, run.unifiedParallel, rest, "stdout");
        }
        run.unifiedParallel.carry = "";
      }
      this.finalizeUnifiedRun(run, code);
    });
  }

  private lineReferencesTestFile(line: string, testFile: string): boolean {
    const base = path.basename(testFile).toLowerCase();
    if (!base) {
      return false;
    }
    return line.toLowerCase().includes(base);
  }

  private emitUnifiedSequentialLine(
    run: Run,
    state: NonNullable<Run["unifiedSeq"]>,
    line: string,
    type: "stdout" | "stderr"
  ): void {
    const progress = run.unifiedProgress;
    if (!progress) {
      return;
    }
    const now = new Date().toISOString();
    for (let i = 0; i < run.items.length; i++) {
      if (this.lineReferencesTestFile(line, run.items[i].testFile) && run.items[i].status === "queued") {
        this.ensureQueuedMarkedStarted(run, i, now);
      }
    }

    if (this.isPlaywrightTestResultLine(line)) {
      const idx = this.matchLineToBestFileIndex(line, run.items);
      if (
        idx !== null &&
        idx === state.activeIndex &&
        !progress.finished.has(idx) &&
        state.activeIndex < run.items.length
      ) {
        if (this.resultLineIndicatesFail(line)) {
          progress.anyFailed[idx] = true;
        }
        progress.completed[idx]++;
        if (progress.completed[idx] >= progress.expected[idx]) {
          this.emitFileFinishedForItem(run, idx, null, progress);
          state.activeIndex++;
          while (state.activeIndex < run.items.length && progress.finished.has(state.activeIndex)) {
            state.activeIndex++;
          }
          if (state.activeIndex < run.items.length) {
            const next = run.items[state.activeIndex];
            next.status = "running";
            next.startedAt = new Date().toISOString();
            this.emit(run, {
              type: "item_started",
              runId: run.runId,
              itemId: next.itemId,
              testFile: next.testFile,
            });
          }
        }
      }
    }

    const routeIdx = this.matchLineToBestFileIndex(line, run.items);
    const cap = Math.max(0, run.items.length - 1);
    const safeActive = Math.min(state.activeIndex, cap);
    const targetIdx = routeIdx !== null ? routeIdx : safeActive;
    const it = run.items[targetIdx];
    this.emit(run, {
      type,
      runId: run.runId,
      itemId: it.itemId,
      testFile: it.testFile,
      chunk: `${line}\n`,
    });
  }

  /**
   * Paralelo unificado: estados por archivo según resultados parseados y conteo previo (`--list`).
   */
  private emitUnifiedParallelLine(
    run: Run,
    state: NonNullable<Run["unifiedParallel"]>,
    line: string,
    type: "stdout" | "stderr"
  ): void {
    const progress = run.unifiedProgress;
    const pool = state.runningPool;
    const now = new Date().toISOString();

    if (progress) {
      for (let i = 0; i < run.items.length; i++) {
        if (this.lineReferencesTestFile(line, run.items[i].testFile) && run.items[i].status === "queued") {
          this.ensureQueuedMarkedStarted(run, i, now, state);
        }
      }

      if (this.isPlaywrightTestResultLine(line)) {
        const idx = this.matchLineToBestFileIndex(line, run.items);
        if (idx !== null && !progress.finished.has(idx)) {
          if (this.resultLineIndicatesFail(line)) {
            progress.anyFailed[idx] = true;
          }
          progress.completed[idx]++;
          if (progress.completed[idx] >= progress.expected[idx]) {
            this.emitFileFinishedForItem(run, idx, null, progress);
          }
        }
      }
    }

    const routeIdx = this.matchLineToBestFileIndex(line, run.items);
    const chunk = `${line}\n`;
    if (routeIdx !== null && (pool.has(routeIdx) || run.items[routeIdx].status === "running")) {
      const it = run.items[routeIdx];
      this.emit(run, {
        type,
        runId: run.runId,
        itemId: it.itemId,
        testFile: it.testFile,
        chunk,
      });
      return;
    }

    for (const idx of pool) {
      if (progress?.finished.has(idx)) {
        continue;
      }
      const it = run.items[idx];
      this.emit(run, {
        type,
        runId: run.runId,
        itemId: it.itemId,
        testFile: it.testFile,
        chunk,
      });
    }
  }

  private finalizeUnifiedRun(run: Run, exitCode: number | null): void {
    if (run.completed) {
      return;
    }
    run.completed = true;
    run.batchProcess = undefined;
    const progressSnapshot = run.unifiedProgress;
    run.unifiedSeq = undefined;
    run.unifiedParallel = undefined;
    run.unifiedProgress = undefined;

    const finishedAt = new Date();
    const iso = finishedAt.toISOString();
    const itemStatus: RunItem["status"] = run.stopped ? "stopped" : exitCode === 0 ? "success" : "failed";

    for (let i = 0; i < run.items.length; i++) {
      const item = run.items[i];
      item.exitCode = run.stopped ? null : exitCode;
      if (progressSnapshot?.finished.has(i)) {
        continue;
      }
      item.finishedAt = iso;
      item.status = itemStatus;
      this.emit(run, {
        type: "item_finished",
        runId: run.runId,
        itemId: item.itemId,
        testFile: item.testFile,
        status: item.status,
        exitCode: item.exitCode,
      });
    }

    let reportPath: string | undefined;
    if (!run.stopped && run.reportStoragePath && run.tmpReportDir && fs.existsSync(run.tmpReportDir)) {
      try {
        const folderName = this.formatReportFolderName(finishedAt);
        let finalDir = path.join(run.reportStoragePath, folderName);
        if (fs.existsSync(finalDir)) {
          finalDir = path.join(run.reportStoragePath, `${folderName}_${randomUUID().slice(0, 8)}`);
        }
        fs.renameSync(run.tmpReportDir, finalDir);
        reportPath = finalDir;
      } catch {
        try {
          fs.rmSync(run.tmpReportDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    } else if (run.tmpReportDir && fs.existsSync(run.tmpReportDir)) {
      try {
        fs.rmSync(run.tmpReportDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    run.tmpReportDir = undefined;
    this.emit(run, { type: "run_finished", runId: run.runId, stopped: run.stopped, reportPath });
    setTimeout(() => this.runs.delete(run.runId), 5 * 60 * 1000);
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

    if (run.batchProcess?.pid) {
      await killProcessTree(run.batchProcess.pid);
      return;
    }

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
    if (run.batchProcess?.pid) {
      await this.stopRun(runId);
      return;
    }
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
      shell: isWindows,
    });
    item.process = child;

    child.on("error", (error: Error) => {
      this.emit(run, {
        type: "stderr",
        runId: run.runId,
        itemId: item.itemId,
        testFile: item.testFile,
        chunk: `Error de ejecución interno: ${error.message}\nVerifica que Playwright esté instalado y accesible.`,
      });
      run.active.delete(item.itemId);
      item.exitCode = 1;
      item.finishedAt = new Date().toISOString();
      item.status = "failed";
      this.emit(run, {
        type: "item_finished",
        runId: run.runId,
        itemId: item.itemId,
        testFile: item.testFile,
        status: item.status,
        exitCode: 1,
      });
      void this.pump(run.runId);
    });

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
