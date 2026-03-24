"use client";

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  browseFs,
  fetchWorkspaceTree,
  getRun,
  pickReportFolder,
  runStreamUrl,
  runTests,
  selectWorkspace,
  stopRun,
  stopRunItem,
  renameTestFile,
} from "../lib/api";
import type { BrowserItem, RunEvent, RunItemStatus, RunMode, TreeNode } from "../lib/types";
import { type Language, useTranslation } from "../lib/i18n";

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
  if (fileName.includes(" ")) return "Spaces not allowed";
  if (/[^A-Za-z0-9._-]/.test(fileName)) return "Invalid characters";
  if (!validNamePattern.test(fileName)) return "Must be .spec.ts or .test.ts";
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
  const [lang, setLang] = useState<Language>("es");
  const { translations: t } = useTranslation(lang);

  const [repoPath, setRepoPath] = useState("");
  const [tree, setTree] = useState<UiNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<RunMode>("sequential");
  const [parallelism, setParallelism] = useState<number>(4);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileState, setFileState] = useState<Record<string, FileState>>({});
  const [batchRunId, setBatchRunId] = useState<string | null>(null);

  // Browser Modal State
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserPath, setBrowserPath] = useState<string>("");
  const [browserItems, setBrowserItems] = useState<BrowserItem[]>([]);
  const [loadingBrowser, setLoadingBrowser] = useState(false);
  const [reportDir, setReportDir] = useState("");
  const [reportNotice, setReportNotice] = useState<string | null>(null);

  const streams = useRef<Record<string, EventSource>>({});

  // Load persistence
  useEffect(() => {
    const savedPath = localStorage.getItem("playwright-repo-path");
    const savedLang = localStorage.getItem("playwright-lang") as Language;
    const savedReportDir = localStorage.getItem("playwright-report-dir");

    if (savedLang && (savedLang === "es" || savedLang === "en")) setLang(savedLang);
    if (savedReportDir) setReportDir(savedReportDir);
    if (savedPath) {
      setRepoPath(savedPath);
      void handleWorkspaceSelect(savedPath);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("playwright-lang", lang);
  }, [lang]);

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

    eventSource.onopen = () => {
      getRun(runId)
        .then((run) => {
          for (const item of run.items) {
            const s = item.status as RunItemStatus | "queued";
            if (s === "queued") continue;
            upsertFileState(item.testFile, {
              status: s === "success" || s === "failed" || s === "stopped" ? (s as RunItemStatus) : "running",
              runId,
              itemId: item.itemId,
            });
          }
        })
        .catch(() => undefined);
    };

    eventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data) as RunEvent;
      if (payload.type === "item_started") {
        upsertFileState(payload.testFile, { status: "running", runId, itemId: payload.itemId, log: "" });
      }
      if (payload.type === "stdout" || payload.type === "stderr") {
        appendFileLog(payload.testFile, payload.chunk);
      }
      if (payload.type === "item_finished") {
        upsertFileState(payload.testFile, { status: payload.status });
      }
      if (payload.type === "run_finished") {
        if ("reportPath" in payload && payload.reportPath) {
          setReportNotice(payload.reportPath);
        }
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
      setError(err instanceof Error ? err.message : "Error selecting workspace.");
    } finally {
      setLoadingRoot(false);
    }
  }

  async function openBrowser(targetPath = "") {
    setShowBrowser(true);
    setLoadingBrowser(true);
    try {
      const items = await browseFs(targetPath);
      setBrowserItems(items);
      setBrowserPath(targetPath);
    } catch (err) {
      setError("Error browsing folders.");
    } finally {
      setLoadingBrowser(false);
    }
  }

  function handleBrowserSelect() {
    if (browserPath) {
      setRepoPath(browserPath);
      void handleWorkspaceSelect(browserPath);
    }
    setShowBrowser(false);
  }

  async function handleBrowserNavigate(item: BrowserItem) {
    if (item.type === "drive" || item.type === "folder") {
      await openBrowser(item.path);
    } else {
      setBrowserPath(item.path);
    }
  }

  async function toggleFolder(node: UiNode) {
    const next = !expanded[node.relativePath];
    setExpanded((prev) => ({ ...prev, [node.relativePath]: next }));
    if (next && !node.loaded) {
      try {
        await loadChildren(node.relativePath);
      } catch (err) {
        setError("Error loading folder.");
      }
    }
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
    try {
      upsertFileState(node.relativePath, { status: "queued", log: "", logOpen: false });
      const run = await runTests([node.relativePath], "sequential", 1, reportDir || undefined);
      connectRunStream(run.runId);
    } catch (err) {
      upsertFileState(node.relativePath, { status: "failed", log: "Error starting run\n" });
    }
  }

  async function runBatch() {
    const files = Array.from(selectedFiles);
    if (!files.length) return;
    try {
      const run = await runTests(files, mode, parallelism, reportDir || undefined);
      setBatchRunId(run.runId);
      for (const file of files) {
        upsertFileState(file, { status: "queued", log: "", logOpen: false });
      }
      connectRunStream(run.runId);
    } catch (err) {
      setError("Error starting batch run.");
    }
  }

  async function stopSingle(file: string) {
    const state = fileState[file];
    if (!state?.runId || !state?.itemId) return;
    void stopRunItem(state.runId, state.itemId);
  }

  async function stopBatch() {
    if (!batchRunId) return;
    void stopRun(batchRunId);
  }

  async function handleAutoRename(node: UiNode) {
    const parentPath = node.relativePath.split("/").slice(0, -1).join("/");
    const baseName = node.name.replace(/\.(spec|test)\.ts$/, "");
    
    // 1. Detectar separador dominante (_ o -)
    const underscores = (baseName.match(/_/g) || []).length;
    const hyphens = (baseName.match(/-/g) || []).length;
    const preferredSeparator = underscores >= hyphens ? "_" : "-";

    // 2. Limpieza inteligente
    let newName = baseName
      .replace(/[^A-Za-z0-9\s._-]/g, "") // Quitar caracteres raros pero dejar espacios
      .replace(/([A-Za-z0-9])\s+([A-Za-z0-9])/g, `$1${preferredSeparator}$2`) // Espacio entre letras -> separador
      .replace(/\s+/g, "") // Cualquier otro espacio (junto a símbolos) -> borrar
      .replace(/[-_]{2,}/g, preferredSeparator) // Colapsar "--", "__", "-_", "_-" en uno solo
      + ".spec.ts"; // Forzar sufijo estándar

    const from = node.relativePath;
    const to = parentPath ? `${parentPath}/${newName}` : newName;

    try {
      await renameTestFile(from, to);
      // Reload the parent or root to reflect changes
      await loadChildren(parentPath);
    } catch (err) {
      setError(t.renameError);
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
        const hasDirectFiles = node.children?.some(child => child.type === 'file');

        return (
          <div key={node.relativePath} className="tree-node-container" style={{ marginBottom: 4 }}>
            <div
              className="tree-node"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                paddingLeft,
              }}
              onClick={() => void toggleFolder(node)}
            >
              <span style={{ color: "var(--text-dim)", fontSize: 10, width: 14 }}>{isOpen ? "▼" : "▶"}</span>
              <span style={{ fontWeight: 600, color: "var(--text-main)", fontSize: 13 }}>📁 {node.name}</span>
              {hasDirectFiles && folderFiles.length > 0 && (
                <label
                  style={{ marginLeft: "auto", display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', color: 'var(--text-muted)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => toggleFolderSelection(node, event.target.checked)}
                    style={{ width: 14, height: 14 }}
                  />
                  {t.selectAll}
                </label>
              )}
            </div>
            {isOpen && node.children?.length ? (
              <div>{treeView(node.children, depth + 1)}</div>
            ) : isOpen && !node.children?.length && node.hasChildren === false ? (
              <div style={{ paddingLeft: paddingLeft + 24, padding: 8, color: "var(--text-dim)", fontSize: 12 }}>
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
          className={`tree-node ${selected ? 'selected' : ''}`}
          style={{
            paddingLeft,
            marginBottom: 4,
            borderLeft: isInvalid ? '3px solid var(--danger)' : '3px solid transparent',
            background: isInvalid ? 'rgba(248, 113, 113, 0.05)' : 'transparent',
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr auto auto", gap: 12, padding: "10px 12px", alignItems: 'center' }}>
            <div style={{ paddingTop: 2 }}>
              <input
                checked={selected}
                onChange={() => {
                  setSelectedFiles(prev => {
                    const next = new Set(prev);
                    if (next.has(node.relativePath)) next.delete(node.relativePath);
                    else next.add(node.relativePath);
                    return next;
                  });
                }}
                type="checkbox"
                disabled={isInvalid}
                style={{ margin: 0, width: 14, height: 14 }}
              />
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono" style={{ fontSize: 13, color: isInvalid ? "var(--danger)" : "var(--text-main)", whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', minWidth: 0, flex: 1, fontWeight: isInvalid ? 700 : 400 }}>
                  📄 {node.name}
                </span>
              </div>
              
              {isInvalid && (
                <div style={{ color: "var(--warning)", fontSize: "11px", lineHeight: "1.3", opacity: 1, background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px', borderLeft: '2px solid var(--warning)' }}>
                  <strong style={{ textTransform: 'uppercase', fontSize: '9px', display: 'block', marginBottom: '2px' }}>{t.errorNaming}</strong>
                  {invalidReason}. {t.solutionNaming}
                </div>
              )}
              
              {currentStatus === "failed" && (
                <div style={{ color: "var(--danger)", fontSize: "11px", lineHeight: "1.3", opacity: 1, background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px', borderLeft: '2px solid var(--danger)' }}>
                  <strong style={{ textTransform: 'uppercase', fontSize: '9px', display: 'block', marginBottom: '2px' }}>{t.errorExecution}</strong>
                  {t.solutionExecution}
                </div>
              )}
            </div>

            <div style={{ paddingTop: 2 }}>
              <div className={`status-chip status-${currentStatus}`} style={{ minWidth: 80, justifyContent: 'center', flexShrink: 0 }}>
                {t[statusMap[currentStatus] || 'ready']}
              </div>
            </div>

            <div className="actions-container" style={{ display: 'flex', gap: 6, flexShrink: 0, paddingTop: 2 }}>
              {isInvalid && (
                <button
                  className="btn-rename"
                  onClick={(e) => { e.stopPropagation(); void handleAutoRename(node); }}
                  data-tooltip={t.tooltipRename}
                  style={{ height: 30 }}
                >
                  {t.btnRename}
                </button>
              )}
              <button
                className="btn-ghost"
                style={{ width: 30, height: 30, padding: 0, color: 'var(--success)', borderColor: 'rgba(74, 222, 128, 0.2)' }}
                onClick={(e) => { e.stopPropagation(); void runSingle(node); }}
                disabled={isInvalid || currentStatus === "running"}
                data-tooltip={t.tooltipPlay}
              >
                ▶
              </button>
              <button
                className="btn-ghost"
                style={{ width: 30, height: 30, padding: 0, color: 'var(--danger)', borderColor: 'rgba(248, 113, 113, 0.2)' }}
                onClick={(e) => { e.stopPropagation(); void stopSingle(node.relativePath); }}
                disabled={currentStatus !== "running"}
                data-tooltip={t.tooltipStop}
              >
                ■
              </button>
              <button
                className="btn-ghost"
                style={{ width: 30, height: 30, padding: 0 }}
                onClick={(e) => { e.stopPropagation(); upsertFileState(node.relativePath, { logOpen: !state?.logOpen }); }}
                data-tooltip={t.tooltipLog}
              >
                <span style={{ fontSize: 16 }}>⌘</span>
              </button>
            </div>
          </div>
          {state?.logOpen && (
            <div style={{ padding: "0 12px 12px 12px" }}>
              <div className="terminal-view" style={{ maxHeight: 300, overflow: "auto" }}>
                {state.log || "$ waiting for logs..."}
              </div>
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div>
          <h1><span>▶</span> {t.title}<br/>{t.subtitle}</h1>
          <div className="toggle-pill" style={{ marginTop: '1.5rem' }}>
            <button className={lang === 'es' ? 'active' : ''} onClick={() => setLang('es')}>ES</button>
            <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
          </div>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <h2>{t.config}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder={t.placeholder}
              className="mono"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button className="btn-primary" onClick={() => void handleWorkspaceSelect()} disabled={loadingRoot}>
                {loadingRoot ? t.loading : t.loadPath}
              </button>
              <button className="btn-ghost" onClick={() => void openBrowser()}>
                {t.search}
              </button>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <h2>{t.reportsSection}</h2>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.4 }}>{t.reportsHint}</p>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
            {t.reportsFolderLabel}
          </label>
          <input
            readOnly
            value={reportDir}
            placeholder="—"
            className="mono"
            style={{ marginBottom: 8, fontSize: 11 }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                void (async () => {
                  try {
                    setError(null);
                    const p = await pickReportFolder();
                    if (p) {
                      setReportDir(p);
                      localStorage.setItem("playwright-report-dir", p);
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Error al elegir carpeta.");
                  }
                })();
              }}
            >
              {t.reportsPick}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={!reportDir}
              onClick={() => {
                setReportDir("");
                localStorage.removeItem("playwright-report-dir");
              }}
            >
              {t.reportsClear}
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <h2>{t.mode}</h2>
          <div className="toggle-pill" style={{ width: '100%', marginBottom: 12 }}>
            <button style={{ flex: 1 }} className={mode === 'sequential' ? 'active' : ''} onClick={() => setMode('sequential')}>
              {t.sequential}
            </button>
            <button style={{ flex: 1 }} className={mode === 'parallel' ? 'active' : ''} onClick={() => setMode('parallel')}>
              {t.parallel}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 16 }}>
            {mode === 'sequential' ? t.hintSequential : t.hintParallel}
          </p>

          {mode === 'parallel' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }} data-tooltip={t.clueWorkers}>
                {t.workers} ⓘ
              </label>
              <input 
                type="number" 
                min={1} 
                style={{ width: 60, padding: '4px 8px', textAlign: 'center' }} 
                value={parallelism} 
                onChange={(e) => setParallelism(Math.max(1, +e.target.value))} 
              />
            </div>
          )}
        </div>

        <div style={{ marginTop: 'auto' }}>
           <button 
             className="btn-primary" 
             style={{ width: '100%', padding: '12px', fontSize: 14 }}
             onClick={() => void runBatch()}
             disabled={selectedFiles.size === 0}
           >
             {t.executeBatch} ({selectedFiles.size})
           </button>
           <button 
             className="btn-ghost" 
             style={{ width: '100%', marginTop: 8, color: 'var(--danger)', borderColor: 'rgba(248, 113, 113, 0.2)' }}
             onClick={() => void stopBatch()}
             disabled={!batchRunId}
           >
             {t.stopAll}
           </button>
        </div>
      </aside>

      <main className="content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{t.treeTitle}</h2>
          <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 12px' }} onClick={() => setSelectedFiles(new Set())}>
            {t.clear}
          </button>
        </div>

        {error && (
          <div style={{ padding: '12px', background: 'rgba(248, 113, 113, 0.1)', border: '1px solid var(--danger)', borderRadius: 8, color: 'var(--danger)', fontSize: 13 }}>
            <strong>{t.errorTitle}:</strong> {error}
          </div>
        )}

        {reportNotice && (
          <div
            style={{
              padding: '12px',
              background: 'rgba(74, 222, 128, 0.08)',
              border: '1px solid rgba(74, 222, 128, 0.35)',
              borderRadius: 8,
              color: 'var(--text-main)',
              fontSize: 13,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <div>
              <strong style={{ color: 'var(--success)' }}>{t.reportSaved}</strong>
              <div className="mono" style={{ marginTop: 6, fontSize: 12, wordBreak: 'break-all' }}>{reportNotice}</div>
            </div>
            <button type="button" className="btn-ghost" style={{ flexShrink: 0, padding: '4px 10px' }} onClick={() => setReportNotice(null)}>
              ×
            </button>
          </div>
        )}

        <div className="card" style={{ flex: 1, padding: '8px 0', overflowY: 'auto', background: 'rgba(15, 23, 42, 0.5)' }}>
          {tree.length > 0 ? (
            <div style={{ padding: '0 8px' }}>{treeView(tree)}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', gap: 16 }}>
               <span style={{ fontSize: 48, opacity: 0.2 }}>📁</span>
               <p>{t.noWorkspace}</p>
            </div>
          )}
        </div>
      </main>

      {/* --- Browser Modal --- */}
      {showBrowser && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div style={{ padding: "1.25rem", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>{t.browseFolders}</h2>
              <button onClick={() => setShowBrowser(false)} style={{ background: "transparent", fontSize: 24, color: 'var(--text-muted)' }}>×</button>
            </div>
            <div style={{ padding: "0.75rem", background: "var(--bg-app)", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn-ghost" style={{ padding: '4px 8px' }} onClick={() => openBrowser("")}>{t.home}</button>
              <div style={{ background: "var(--bg-sidebar)", border: "1px solid var(--border)", padding: "8px 12px", borderRadius: 8, flex: 1, fontSize: 12, color: 'var(--primary)' }} className="mono">
                {browserPath || t.thisPC}
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "1rem" }}>
              {loadingBrowser ? (
                <div style={{ textAlign: "center", padding: "2rem", color: 'var(--text-dim)' }}>{t.loading}</div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
                  {browserItems.map((item) => (
                    <div
                      key={item.path}
                      onClick={() => handleBrowserNavigate(item)}
                      className="tree-node"
                      style={{
                        padding: "12px",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        background: "var(--bg-app)"
                      }}
                    >
                      <span style={{ fontSize: 20 }}>{item.type === "drive" ? "💽" : "📁"}</span>
                      <div style={{ overflow: "hidden" }}>
                        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: 'hidden', color: 'var(--text-main)' }}>{item.name}</div>
                        <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: 'uppercase' }}>{item.type}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ padding: "1.25rem", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 12 }}>
              <button className="btn-ghost" onClick={() => setShowBrowser(false)}>{t.cancel}</button>
              <button className="btn-primary" onClick={handleBrowserSelect} disabled={!browserPath}>{t.selectFolder}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
