"use client";

import { type ReactElement, useMemo, useRef, useState } from "react";
import {
  fetchWorkspaceTree,
  pickWorkspaceFolder,
  runStreamUrl,
  runTests,
  selectWorkspace,
  stopRun,
  stopRunItem,
} from "../lib/api";
import type { RunEvent, RunItemStatus, RunMode, TreeNode } from "../lib/types";

type UiNode = TreeNode & { children?: UiNode[]; loaded?: boolean };

type FileState = {
  status: RunItemStatus | "idle";
  log: string;
  runId?: string;
  itemId?: string;
  logOpen: boolean;
};

const folderSkip = new Set(["node_modules", ".git", "dist", "playwright-report", "test-results"]);
const validNamePattern = /^[A-Za-z0-9._-]+\.(spec|test)\.ts$/;

function byNameAsc(a: UiNode, b: UiNode): number {
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function mergeChildren(target: UiNode, children: TreeNode[]): UiNode {
  return {
    ...target,
    loaded: true,
    children: children
      .filter((node) => !folderSkip.has(node.name))
      .map((node) => ({ ...node, loaded: false }))
      .sort(byNameAsc),
  };
}

function updateNode(nodes: UiNode[], relativePath: string, children: TreeNode[]): UiNode[] {
  return nodes.map((node) => {
    if (node.relativePath === relativePath && node.type === "folder") {
      return mergeChildren(node, children);
    }
    if (node.children?.length) {
      return { ...node, children: updateNode(node.children, relativePath, children) };
    }
    return node;
  });
}

function getInvalidNameReason(fileName: string): string | null {
  if (fileName.includes(" ")) {
    return "Contiene espacios.";
  }
  if (/[^A-Za-z0-9._-]/.test(fileName)) {
    return "Solo se permiten letras, numeros, punto (.), guion (-) y guion bajo (_).";
  }
  if (!validNamePattern.test(fileName)) {
    return "Formato requerido: <nombre>.spec.ts o <nombre>.test.ts";
  }
  return null;
}

function isSelectableFile(node: UiNode): boolean {
  return node.type === "file" && !getInvalidNameReason(node.name);
}

function collectSelectableFiles(nodes: UiNode[]): string[] {
  const files: string[] = [];
  for (const node of nodes) {
    if (isSelectableFile(node)) {
      files.push(node.relativePath);
      continue;
    }
    if (node.type === "folder" && node.children?.length) {
      files.push(...collectSelectableFiles(node.children));
    }
  }
  return files;
}

function collectSelectableFilesFromFolder(node: UiNode): string[] {
  if (node.type !== "folder" || !node.children?.length) {
    return [];
  }
  return collectSelectableFiles(node.children);
}

export default function HomePage() {
  const [repoPath, setRepoPath] = useState("");
  const [tree, setTree] = useState<UiNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<RunMode>("sequential");
  const [parallelism, setParallelism] = useState<number>(1);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileState, setFileState] = useState<Record<string, FileState>>({});
  const [batchRunId, setBatchRunId] = useState<string | null>(null);

  const streams = useRef<Record<string, EventSource>>({});

  const discoveredSelectableFiles = useMemo(() => collectSelectableFiles(tree), [tree]);

  function upsertFileState(file: string, patch: Partial<FileState>) {
    setFileState((prev) => ({
      ...prev,
      [file]: {
        ...prev[file],
        ...patch,
        status: patch.status ?? prev[file]?.status ?? "idle",
        log: patch.log ?? prev[file]?.log ?? "",
        logOpen: patch.logOpen ?? prev[file]?.logOpen ?? false,
      },
    }));
  }

  function appendFileLog(file: string, chunk: string) {
    setFileState((prev) => ({
      ...prev,
      [file]: {
        ...prev[file],
        status: prev[file]?.status ?? "idle",
        logOpen: prev[file]?.logOpen ?? false,
        log: `${prev[file]?.log ?? ""}${chunk}`,
      },
    }));
  }

  async function loadChildren(relativePath = "") {
    const children = await fetchWorkspaceTree(relativePath);
    if (!relativePath) {
      setTree(
        children
          .filter((node) => !folderSkip.has(node.name))
          .map((node) => ({ ...node, loaded: false }))
          .sort(byNameAsc)
      );
      return;
    }
    setTree((prev) => updateNode(prev, relativePath, children));
  }

  function connectRunStream(runId: string) {
    if (streams.current[runId]) return;
    const eventSource = new EventSource(runStreamUrl(runId));
    streams.current[runId] = eventSource;

    eventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data) as RunEvent;
      if (payload.type === "item_started") {
        upsertFileState(payload.testFile, {
          status: "running",
          runId,
          itemId: payload.itemId,
        });
      }
      if (payload.type === "stdout" || payload.type === "stderr") {
        appendFileLog(payload.testFile, payload.chunk);
      }
      if (payload.type === "item_finished") {
        upsertFileState(payload.testFile, {
          status: payload.status,
          logOpen: payload.status !== "success",
        });
      }
      if (payload.type === "run_finished") {
        eventSource.close();
        delete streams.current[runId];
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      delete streams.current[runId];
    };
  }

  async function handleWorkspaceSelect(pathValue?: string) {
    const value = (pathValue ?? repoPath).trim();
    if (!value) return;
    setError(null);
    setLoadingRoot(true);
    setSelectedFiles(new Set());
    try {
      await selectWorkspace(value);
      setRepoPath(value);
      await loadChildren("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo seleccionar workspace.");
    } finally {
      setLoadingRoot(false);
    }
  }

  async function handleBrowseWorkspace() {
    setError(null);
    setLoadingRoot(true);
    try {
      const pickedPath = await pickWorkspaceFolder();
      if (!pickedPath) return;
      await handleWorkspaceSelect(pickedPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir el explorador de carpetas.");
    } finally {
      setLoadingRoot(false);
    }
  }

  async function toggleFolder(node: UiNode) {
    const next = !expanded[node.relativePath];
    setExpanded((prev) => ({ ...prev, [node.relativePath]: next }));
    if (next && !node.loaded) {
      try {
        await loadChildren(node.relativePath);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cargar la carpeta.");
      }
    }
  }

  function toggleSelection(file: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  function toggleFolderSelection(node: UiNode, shouldSelect: boolean) {
    const folderFiles = collectSelectableFilesFromFolder(node);
    if (folderFiles.length === 0) return;
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      for (const file of folderFiles) {
        if (shouldSelect) next.add(file);
        else next.delete(file);
      }
      return next;
    });
  }

  function selectAllLoaded() {
    setSelectedFiles(new Set(discoveredSelectableFiles));
  }

  function clearSelection() {
    setSelectedFiles(new Set());
  }

  async function runSingle(node: UiNode) {
    if (node.type !== "file") return;
    const invalidReason = getInvalidNameReason(node.name);
    if (invalidReason) return;

    try {
      upsertFileState(node.relativePath, { status: "queued", log: "", logOpen: false });
      const run = await runTests([node.relativePath], "sequential", 1);
      setBatchRunId(run.runId);
      for (const item of run.items) {
        upsertFileState(item.testFile, {
          status: item.status,
          runId: run.runId,
          itemId: item.itemId,
        });
      }
      connectRunStream(run.runId);
    } catch (err) {
      upsertFileState(node.relativePath, {
        status: "failed",
        log: `${err instanceof Error ? err.message : "Error al ejecutar prueba."}\n`,
        logOpen: true,
      });
    }
  }

  async function runBatch() {
    const files = Array.from(selectedFiles);
    if (!files.length) return;
    setError(null);
    try {
      const run = await runTests(files, mode, parallelism);
      setBatchRunId(run.runId);
      for (const item of run.items) {
        upsertFileState(item.testFile, {
          status: item.status,
          runId: run.runId,
          itemId: item.itemId,
          log: "",
          logOpen: false,
        });
      }
      connectRunStream(run.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar ejecución por lote.");
    }
  }

  async function stopSingle(file: string) {
    const state = fileState[file];
    if (!state?.runId || !state?.itemId) return;
    try {
      await stopRunItem(state.runId, state.itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo detener la prueba.");
    }
  }

  async function stopBatch() {
    if (!batchRunId) return;
    try {
      await stopRun(batchRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo detener el lote.");
    }
  }

  const treeView = (nodes: UiNode[], depth = 0): ReactElement[] =>
    nodes.map((node) => {
      const paddingLeft = 12 + depth * 14;
      const isOpen = !!expanded[node.relativePath];

      if (node.type === "folder") {
        const folderFiles = collectSelectableFilesFromFolder(node);
        const selectedCount = folderFiles.filter((file) => selectedFiles.has(file)).length;
        const allSelected = folderFiles.length > 0 && selectedCount === folderFiles.length;

        return (
          <div key={node.relativePath} style={{ paddingLeft, marginBottom: 4 }}>
            <div
              style={{
                background: "#edf2f7",
                borderRadius: 8,
                padding: "6px 8px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <button
                style={{
                  background: "transparent",
                  textAlign: "left",
                  fontWeight: 600,
                  padding: 0,
                  color: "#0f172a",
                }}
                onClick={() => void toggleFolder(node)}
                type="button"
              >
                {isOpen ? "▼" : "▶"} {node.name}
              </button>
              {isOpen && folderFiles.length > 0 ? (
                <label
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#b91c1c", fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => toggleFolderSelection(node, event.target.checked)}
                  />
                  Select All
                </label>
              ) : null}
            </div>
            {isOpen && node.children?.length ? treeView(node.children, depth + 1) : null}
          </div>
        );
      }

      const state = fileState[node.relativePath];
      const selected = selectedFiles.has(node.relativePath);
      const invalidReason = getInvalidNameReason(node.name);
      const isInvalid = !!invalidReason;

      return (
        <div
          key={node.relativePath}
          style={{
            paddingLeft,
            marginBottom: 4,
            border: `1px solid ${isInvalid ? "#fca5a5" : "#d8e1ec"}`,
            borderRadius: 8,
            background: isInvalid ? "#fff1f2" : "#fff",
          }}
          title={isInvalid ? `Nombre inválido: ${invalidReason}` : ""}
        >
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr auto auto", gap: 8, padding: 8 }}>
            <input
              checked={selected}
              onChange={() => toggleSelection(node.relativePath)}
              type="checkbox"
              title={isInvalid ? "No seleccionable por conflicto de nombre" : "Seleccionar test"}
              disabled={isInvalid}
            />
            <div style={{ overflow: "hidden" }}>
              <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                {node.name}
              </span>
              {isInvalid ? (
                <span style={{ color: "#b91c1c", fontSize: 12 }}>Nombre errado: {invalidReason}</span>
              ) : null}
            </div>
            <span style={{ textTransform: "uppercase", fontSize: 12 }}>{state?.status ?? "idle"}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={() => void runSingle(node)}
                style={{ background: "#1b9e5a", color: "white" }}
                disabled={isInvalid}
              >
                Play
              </button>
              <button
                type="button"
                onClick={() => void stopSingle(node.relativePath)}
                style={{ background: "#c53030", color: "white" }}
                disabled={isInvalid}
              >
                Stop
              </button>
              <button
                type="button"
                onClick={() =>
                  upsertFileState(node.relativePath, { logOpen: !(fileState[node.relativePath]?.logOpen ?? false) })
                }
                style={{ background: "#e2e8f0" }}
              >
                Log
              </button>
            </div>
          </div>
          {state?.logOpen ? (
            <pre
              style={{
                margin: 0,
                padding: 10,
                borderTop: "1px solid #e2e8f0",
                background: "#0f172a",
                color: "#d9f99d",
                whiteSpace: "pre-wrap",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {state.log || "(sin logs)"}
            </pre>
          ) : null}
        </div>
      );
    });

  return (
    <main>
      <h1 style={{ marginTop: 0 }}>Playwright Runner (Next.js)</h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <label htmlFor="repoPath" style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>
          Ruta raíz del repo Playwright (donde existe playwright.config.ts)
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8 }}>
          <input
            id="repoPath"
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleWorkspaceSelect();
              }
            }}
            placeholder="C:\\ruta\\a\\repo-playwright"
          />
          <button
            onClick={() => void handleWorkspaceSelect()}
            style={{ background: "#64748b", color: "white" }}
            disabled={loadingRoot}
          >
            Cargar ruta
          </button>
          <button
            onClick={() => void handleBrowseWorkspace()}
            style={{ background: "#2563eb", color: "white" }}
            disabled={loadingRoot}
          >
            {loadingRoot ? "Cargando..." : "Seleccionar"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "#fecaca", background: "#fff5f5", color: "#9b2c2c" }}>
          {error}
        </div>
      ) : null}

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Árbol y ejecución</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button type="button" onClick={selectAllLoaded} style={{ background: "#e2e8f0" }}>
            Seleccionar cargados
          </button>
          <button type="button" onClick={clearSelection} style={{ background: "#e2e8f0" }}>
            Limpiar selección
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: 8, marginBottom: 10 }}>
          <select value={mode} onChange={(event) => setMode(event.target.value as RunMode)}>
            <option value="sequential">Secuencia</option>
            <option value="parallel">Paralelo</option>
          </select>
          <input
            type="number"
            min={1}
            value={parallelism}
            onChange={(event) => setParallelism(Math.max(1, Number(event.target.value)))}
            disabled={mode === "sequential"}
            title="Paralelismo sin limite duro (usar con cuidado)"
          />
          <span style={{ alignSelf: "center" }}>{selectedFiles.size} seleccionados</span>
          <button type="button" onClick={() => void runBatch()} style={{ background: "#1b9e5a", color: "white" }}>
            Ejecutar lote
          </button>
          <button type="button" onClick={() => void stopBatch()} style={{ background: "#c53030", color: "white" }}>
            Detener lote
          </button>
        </div>
        <div>{treeView(tree)}</div>
      </section>
    </main>
  );
}
