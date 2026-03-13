import type { RunCreated, RunMode, TreeNode } from "./types";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  let data: unknown;

  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    const text = await response.text();
    const preview = text.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `Respuesta no JSON desde API (${response.status}). Verifica API en puerto 3001. Preview: ${preview}`
    );
  }

  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : "Request failed";
    throw new Error(message);
  }
  return data as T;
}

export async function selectWorkspace(repoPath: string): Promise<void> {
  await fetchJson(`${API_BASE_URL}/api/workspace/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath }),
  });
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  const payload = await fetchJson<{ path: string | null }>(
    `${API_BASE_URL}/api/workspace/pick`,
    {
      method: "POST",
    }
  );
  return payload.path;
}

export async function fetchWorkspaceTree(relativePath = ""): Promise<TreeNode[]> {
  const query = new URLSearchParams();
  if (relativePath) {
    query.set("relativePath", relativePath);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const payload = await fetchJson<{ nodes: TreeNode[] }>(
    `${API_BASE_URL}/api/workspace/tree${suffix}`
  );
  return payload.nodes;
}

export async function runTests(
  testFiles: string[],
  mode: RunMode,
  parallelism: number
): Promise<RunCreated> {
  return fetchJson<RunCreated>(`${API_BASE_URL}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ testFiles, mode, parallelism }),
  });
}

export async function stopRun(runId: string): Promise<void> {
  await fetchJson(`${API_BASE_URL}/api/runs/${runId}/stop`, { method: "POST" });
}

export async function stopRunItem(runId: string, itemId: string): Promise<void> {
  await fetchJson(`${API_BASE_URL}/api/runs/${runId}/items/${itemId}/stop`, {
    method: "POST",
  });
}

export function runStreamUrl(runId: string): string {
  return `${API_BASE_URL}/api/runs/${runId}/stream`;
}
