"use client";

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  browseFs,
  fetchWorkspaceTree,
  pickWorkspaceFolder,
  runStreamUrl,
  runTests,
  selectWorkspace,
  stopRun,
  stopRunItem,
} from "../lib/api";
import type { BrowserItem, RunEvent, RunItemStatus, RunMode, TreeNode } from "../lib/types";

type UiNode = TreeNode & { children?: UiNode[]; loaded?: boolean };

type FileState = {
  status: RunItemStatus | "idle";
  log: string;
  runId?: string;
  itemId?: string;
  logOpen: boolean;
};

const translations = {
  es: {
    title: "Playwright Runner",
    config: "Configuración del Workspace",
    loadPath: "Cargar ruta",
    search: "Buscar",
    loading: "Cargando...",
    errorTitle: "⚠️ Error",
    treeTitle: "Árbol de Pruebas y Ejecución",
    selectAll: "Seleccionar todo",
    clear: "Limpiar",
    mode: "Modo de Ejecución:",
    workers: "Hilos (Workers):",
    sequential: "Secuencial",
    parallel: "Paralelo",
    selected: "seleccionados",
    executeBatch: "Ejecutar lote",
    stopAll: "Detener todo",
    noWorkspace: "Workspace no cargado. Carga una ruta para ver las pruebas.",
    browseFolders: "Explorar carpetas",
    home: "🏠",
    thisPC: "Este Equipo",
    cancel: "Cancelar",
    selectFolder: "Seleccionar Carpeta",
    noTests: "(No hay archivos de test directos)",
    ready: "Listo",
    running: "Corriendo",
    passed: "Pasó",
    failed: "Falló",
    queued: "En cola",
    placeholder: "C:\\ruta\\al\\repositorio",
    hintSequential: "Las pruebas se ejecutarán una tras otra. Ideal para depurar o evitar conflictos de datos.",
    hintParallel: "Las pruebas se ejecutarán simultáneamente usando múltiples hilos. Mucho más rápido.",
  },
  en: {
    title: "Playwright Runner",
    config: "Workspace Configuration",
    loadPath: "Load Path",
    search: "Search",
    loading: "Loading...",
    errorTitle: "⚠️ Error",
    treeTitle: "Test Tree & Execution",
    selectAll: "Select All",
    clear: "Clear",
    mode: "Execution Mode:",
    workers: "Workers:",
    sequential: "Sequential",
    parallel: "Parallel",
    selected: "selected",
    executeBatch: "Execute Batch",
    stopAll: "Stop All",
    noWorkspace: "Workspace not loaded. Load a path to see tests.",
    browseFolders: "Browse Folders",
    home: "🏠",
    thisPC: "This PC",
    cancel: "Cancel",
    selectFolder: "Select Folder",
    noTests: "(No direct test files)",
    ready: "Ready",
    running: "Running",
    passed: "Passed",
    failed: "Failed",
    queued: "Queued",
    placeholder: "C:\\path\\to\\repository",
    hintSequential: "Tests will run one after another. Best for debugging or avoiding data conflicts.",
    hintParallel: "Tests will run simultaneously using multiple workers. Much faster.",
  },
} as const;

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
  if (fileName.includes(" ")) return "Contiene espacios.";
  if (/[^A-Za-z0-9._-]/.test(fileName)) return "Solo se permiten letras, números, punto (.), guion (-) y guion bajo (_).";
  if (!validNamePattern.test(fileName)) return "Formato requerido: <nombre>.spec.ts o <nombre>.test.ts";
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
  if (node.type !== "folder" || !node.children?.length) return [];
  return collectSelectableFiles(node.children);
}

export default function HomePage() {
  const [lang, setLang] = useState<"es" | "en">("es");
  const t = translations[lang];

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

  // Browser Modal State
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserPath, setBrowserPath] = useState<string>("");
  const [browserItems, setBrowserItems] = useState<BrowserItem[]>([]);
  const [loadingBrowser, setLoadingBrowser] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const streams = useRef<Record<string, EventSource>>({});
  const discoveredSelectableFiles = useMemo(() => collectSelectableFiles(tree), [tree]);

  // Load persistence
  useEffect(() => {
    const savedPath = localStorage.getItem("playwright-repo-path");
    const savedLang = localStorage.getItem("playwright-lang") as "es" | "en";
    const savedViewMode = localStorage.getItem("playwright-browser-view") as "grid" | "list";
    
    if (savedLang && (savedLang === "es" || savedLang === "en")) setLang(savedLang);
    if (savedViewMode && (savedViewMode === "grid" || savedViewMode === "list")) setViewMode(savedViewMode);
    
    if (savedPath) {
      setRepoPath(savedPath);
      // Auto-load if path exists
      void handleWorkspaceSelect(savedPath);
    }
  }, []);

  // Save persistence
  useEffect(() => {
    localStorage.setItem("playwright-lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("playwright-browser-view", viewMode);
  }, [viewMode]);

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
        upsertFileState(payload.testFile, { status: "running", runId, itemId: payload.itemId });
      }
      if (payload.type === "stdout" || payload.type === "stderr") {
        appendFileLog(payload.testFile, payload.chunk);
      }
      if (payload.type === "item_finished") {
        upsertFileState(payload.testFile, { status: payload.status, logOpen: payload.status !== "success" });
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
      localStorage.setItem("playwright-repo-path", value);
      await loadChildren("");
    } catch (err) {
      setError(err instanceof Error ? err.message : (lang === 'es' ? "No se pudo seleccionar workspace." : "Could not select workspace."));
    } finally {
      setLoadingRoot(false);
    }
  }

  // --- Browser Logic ---
  async function openBrowser(targetPath = "") {
    setShowBrowser(true);
    setLoadingBrowser(true);
    try {
      const items = await browseFs(targetPath);
      setBrowserItems(items);
      setBrowserPath(targetPath);
    } catch (err) {
      setError(lang === 'es' ? "Error al navegar carpetas." : "Error browsing folders.");
    } finally {
      setLoadingBrowser(false);
    }
  }

  async function handleBrowserNavigate(item: BrowserItem) {
    await openBrowser(item.path);
  }

  function handleBrowserSelect() {
    if (browserPath) {
      setRepoPath(browserPath);
      void handleWorkspaceSelect(browserPath);
    }
    setShowBrowser(false);
  }

  async function toggleFolder(node: UiNode) {
    const next = !expanded[node.relativePath];
    setExpanded((prev) => ({ ...prev, [node.relativePath]: next }));
    if (next && !node.loaded) {
      try {
        await loadChildren(node.relativePath);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error loading folder.");
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

  async function runSingle(node: UiNode) {
    if (node.type !== "file") return;
    const invalidReason = getInvalidNameReason(node.name);
    if (invalidReason) return;

    try {
      upsertFileState(node.relativePath, { status: "queued", log: "", logOpen: false });
      const run = await runTests([node.relativePath], "sequential", 1);
      setBatchRunId(run.runId);
      for (const item of run.items) {
        upsertFileState(item.testFile, { status: item.status, runId: run.runId, itemId: item.itemId });
      }
      connectRunStream(run.runId);
    } catch (err) {
      upsertFileState(node.relativePath, {
        status: "failed",
        log: `${err instanceof Error ? err.message : "Error."}\n`,
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
      setError(err instanceof Error ? err.message : "Error starting batch run.");
    }
  }

  async function stopSingle(file: string) {
    const state = fileState[file];
    if (!state?.runId || !state?.itemId) return;
    try {
      await stopRunItem(state.runId, state.itemId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error stopping test.");
    }
  }

  async function stopBatch() {
    if (!batchRunId) return;
    try {
      await stopRun(batchRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error stopping batch.");
    }
  }

  const statusMap: Record<string, keyof typeof t> = {
    idle: "ready",
    running: "running",
    success: "passed",
    failed: "failed",
    queued: "queued",
  };

  const treeView = (nodes: UiNode[], depth = 0): ReactElement[] =>
    nodes.map((node) => {
      const paddingLeft = 12 + depth * 16;
      const isOpen = !!expanded[node.relativePath];

      if (node.type === "folder") {
        const folderFiles = collectSelectableFilesFromFolder(node);
        const selectedCount = folderFiles.filter((file) => selectedFiles.has(file)).length;
        const allSelected = folderFiles.length > 0 && selectedCount === folderFiles.length;
        
        // Only show Select All if the folder contains direct file children
        const hasDirectFiles = node.children?.some(child => child.type === 'file');

        return (
          <div key={node.relativePath} className="tree-node" style={{ marginBottom: 2 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                paddingLeft,
                cursor: "pointer",
              }}
              onClick={() => void toggleFolder(node)}
            >
              <span style={{ color: "var(--text-muted)", fontSize: 10, width: 14 }}>{isOpen ? "▼" : "▶"}</span>
              <span style={{ fontWeight: 600, color: "#475569" }}>📁 {node.name}</span>
              {hasDirectFiles && folderFiles.length > 0 && (
                <label
                  className="select-all-container"
                  style={{ marginLeft: "auto", fontSize: 12, cursor: 'pointer' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => toggleFolderSelection(node, event.target.checked)}
                  />
                  {t.selectAll}
                </label>
              )}
            </div>
            {isOpen && node.children?.length ? (
              <div>{treeView(node.children, depth + 1)}</div>
            ) : isOpen && !node.children?.length && node.hasChildren === false ? (
              <div style={{ paddingLeft: paddingLeft + 24, padding: 4, color: "#94a3b8", fontSize: 11 }}>
                {t.noTests}
              </div>
            ) : null}
          </div>
        );
      }

      const state = fileState[node.relativePath];
      const selected = selectedFiles.has(node.relativePath);
      const invalidReason = getInvalidNameReason(node.name);
      const isInvalid = !!invalidReason;
      const currentStatus = state?.status ?? "idle";

      return (
        <div
          key={node.relativePath}
          className="tree-node"
          style={{
            paddingLeft,
            marginBottom: 2,
            borderLeft: `2px solid ${isInvalid ? "var(--danger)" : "transparent"}`,
          }}
          title={isInvalid ? `Invalid: ${invalidReason}` : ""}
        >
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr auto auto", gap: 12, padding: "8px 12px", alignItems: 'center' }}>
            <input
              checked={selected}
              onChange={() => toggleSelection(node.relativePath)}
              type="checkbox"
              disabled={isInvalid}
              style={{ margin: 0 }}
            />
            <div style={{ overflow: "hidden", minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 13, display: "block", color: isInvalid ? "var(--danger)" : "inherit", whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                📄 {node.name}
              </span>
              {isInvalid && <div style={{ color: "var(--danger)", fontSize: 11, lineHeight: 1 }}>{invalidReason}</div>}
            </div>
            <div className={`status-chip status-${currentStatus}`} style={{ minWidth: 70, justifyContent: 'center' }}>
              {t[statusMap[currentStatus] || 'ready']}
            </div>
            <div className="actions-container">
              <button
                type="button"
                onClick={() => void runSingle(node)}
                style={{ background: "var(--success)", color: "white" }}
                disabled={isInvalid || currentStatus === "running"}
                title="Play"
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => void stopSingle(node.relativePath)}
                style={{ background: "var(--danger)", color: "white" }}
                disabled={currentStatus !== "running"}
                title="Stop"
              >
                ■
              </button>
              <button
                type="button"
                onClick={() => upsertFileState(node.relativePath, { logOpen: !state?.logOpen })}
                style={{ background: "#e2e8f0" }}
                title="Log"
              >
                📋
              </button>
            </div>
          </div>
          {state?.logOpen && (
            <pre style={{ margin: "0 12px 12px 12px", padding: 12, borderRadius: 8, background: "#1e293b", color: "#a5f3fc", fontSize: 12, overflow: "auto", maxHeight: 200 }}>
              {state.log || "(no logs)"}
            </pre>
          )}
        </div>
      );
    });

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1 style={{ margin: 0 }}>{t.title}</h1>
        <div className="lang-toggle">
          <button className={`lang-btn ${lang === 'es' ? 'active' : ''}`} onClick={() => setLang('es')}>ES</button>
          <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {t.config}
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12 }}>
          <input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleWorkspaceSelect()}
            placeholder={t.placeholder}
          />
          <button
            onClick={() => void handleWorkspaceSelect()}
            style={{ background: "var(--primary)", color: "white", minWidth: 120 }}
            disabled={!repoPath.trim() || loadingRoot}
          >
            {loadingRoot ? t.loading : t.loadPath}
          </button>
          <button
            onClick={() => void openBrowser()}
            style={{ background: "#f1f5f9", color: "#334155", border: "1px solid var(--border)" }}
          >
            {t.search}
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ background: "#fef2f2", borderColor: "#fee2e2", color: "#b91c1c", marginBottom: "1.5rem", padding: "1rem" }}>
          {t.errorTitle} {error}
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
          <h2 style={{ margin: 0 }}>{t.treeTitle}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setSelectedFiles(new Set())} style={{ background: "#f1f5f9", color: "#475569", fontSize: 12 }}>
              {t.clear}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: 'column', gap: 16, background: "#f8fafc", padding: "20px", borderRadius: "16px", border: "1px solid #e2e8f0", marginBottom: "1.5rem" }}>
          <div className="mode-toggle-group">
            <label style={{ fontSize: 13, fontWeight: 700, color: '#475569' }}>{t.mode}</label>
            <div className="mode-toggle">
              <button 
                className={`mode-btn ${mode === 'sequential' ? 'active' : ''}`}
                onClick={() => setMode('sequential')}
              >
                <span>🔄</span> {t.sequential}
              </button>
              <button 
                className={`mode-btn ${mode === 'parallel' ? 'active' : ''}`}
                onClick={() => setMode('parallel')}
              >
                <span>⚡</span> {t.parallel}
              </button>
            </div>
            <div className="mode-hint">
              {mode === 'sequential' ? t.hintSequential : t.hintParallel}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {mode === "parallel" && (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label style={{ fontSize: 13, fontWeight: 700, color: '#475569' }}>{t.workers}</label>
                <input type="number" min={1} style={{ width: 70, padding: "8px 12px", borderRadius: 8 }} value={parallelism} onChange={(e) => setParallelism(Math.max(1, +e.target.value))} />
              </div>
            )}
            <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>{selectedFiles.size} {t.selected}</span>
              <button onClick={() => void runBatch()} style={{ background: "var(--success)", color: "white", padding: '10px 20px' }} disabled={selectedFiles.size === 0}>
                {t.executeBatch}
              </button>
              <button onClick={() => void stopBatch()} style={{ background: "var(--danger)", color: "white", padding: '10px 20px' }} disabled={!batchRunId}>
                {t.stopAll}
              </button>
            </div>
          </div>
        </div>

        <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "8px 0", maxHeight: "60vh", overflow: "auto" }}>
          {tree.length > 0 ? treeView(tree) : <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>{t.noWorkspace}</div>}
        </div>
      </div>

      {/* --- Browser Modal --- */}
      {showBrowser && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div style={{ padding: "1.25rem", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f8fafc" }}>
              <h2 style={{ margin: 0 }}>{t.browseFolders}</h2>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div className="view-toggle">
                  <button className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`} onClick={() => setViewMode('grid')} title="Grid View">⊞</button>
                  <button className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')} title="List View">≡</button>
                </div>
                <button onClick={() => setShowBrowser(false)} style={{ background: "transparent", fontSize: 20 }}>×</button>
              </div>
            </div>
            <div style={{ padding: "0.75rem", background: "#fff", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => openBrowser("")} style={{ padding: "4px 8px", background: "#f1f5f9" }}>{t.home}</button>
              <div style={{ background: "#f8fafc", border: "1px solid var(--border)", padding: "6px 12px", borderRadius: 8, flex: 1, fontSize: 13 }} className="mono">
                {browserPath || t.thisPC}
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "1rem" }}>
              {loadingBrowser ? (
                <div style={{ textAlign: "center", padding: "2rem" }}>{t.loading}</div>
              ) : viewMode === 'grid' ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
                  {browserItems.map((item) => (
                    <div
                      key={item.path}
                      onClick={() => handleBrowserNavigate(item)}
                      style={{
                        padding: "12px",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        transition: "all 0.1s",
                        background: "white"
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f8fafc")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "white")}
                    >
                      <span style={{ fontSize: 20 }}>{item.type === "drive" ? "💽" : "📁"}</span>
                      <div style={{ overflow: "hidden" }}>
                        <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: 'hidden' }}>{item.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{item.type}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="browser-view-list">
                  {browserItems.map((item) => (
                    <div
                      key={item.path}
                      className="browser-item-list"
                      onClick={() => handleBrowserNavigate(item)}
                    >
                      <span style={{ fontSize: 18 }}>{item.type === "drive" ? "💽" : "📁"}</span>
                      <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: 'capitalize' }}>{item.type}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ padding: "1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 12, background: "#f8fafc" }}>
              <button onClick={() => setShowBrowser(false)} style={{ background: "white", border: "1px solid var(--border)" }}>{t.cancel}</button>
              <button onClick={handleBrowserSelect} style={{ background: "var(--primary)", color: "white" }} disabled={!browserPath}>{t.selectFolder}</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
