import { BadRequestException, Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { normalizeRelative } from "../common/path-utils";
import { TreeNode } from "./workspace.types";

const TEST_PATTERN = /\.(spec|test)\.ts$/i;
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "playwright-report", "test-results"]);

@Injectable()
export class WorkspaceService {
  private workspaceRoot: string | null = null;

  async pickWorkspaceFolder(): Promise<string | null> {
    if (process.platform !== "win32") {
      throw new BadRequestException("Selector de carpeta nativo solo está soportado en Windows.");
    }

    const command = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      "$dialog.Title = 'Buscar carpeta'",
      "$dialog.Filter = 'Folders|*.none'",
      "$dialog.CheckFileExists = $false",
      "$dialog.CheckPathExists = $true",
      "$dialog.ValidateNames = $false",
      "$dialog.FileName = 'Seleccionar carpeta'",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  $folder = [System.IO.Path]::GetDirectoryName($dialog.FileName)",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $folder",
      "}",
    ].join("; ");

    const selectedPath = await new Promise<string | null>((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", command],
        { windowsHide: true, timeout: 180000 },
        (error, stdout) => {
          if (error) {
            reject(new BadRequestException("No se pudo abrir el explorador de carpetas."));
            return;
          }
          const value = stdout.trim();
          resolve(value ? value : null);
        }
      );
    });

    return selectedPath;
  }

  selectWorkspace(repoPath: string): void {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved)) {
      throw new BadRequestException("Ruta inexistente.");
    }
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      throw new BadRequestException("La ruta debe ser un directorio.");
    }
    const configPath = path.join(resolved, "playwright.config.ts");
    if (!fs.existsSync(configPath)) {
      throw new BadRequestException("No se encontró playwright.config.ts en la ruta.");
    }
    this.workspaceRoot = resolved;
  }

  getWorkspaceRoot(): string {
    if (!this.workspaceRoot) {
      throw new BadRequestException("Workspace no seleccionado.");
    }
    return this.workspaceRoot;
  }

  resolveAbsolute(relativePath: string): string {
    const root = this.getWorkspaceRoot();
    const normalized = normalizeRelative(relativePath);
    return path.resolve(root, normalized);
  }

  listTree(relativePath = ""): TreeNode[] {
    const root = this.getWorkspaceRoot();
    const targetPath = this.resolveAbsolute(relativePath);
    if (!targetPath.startsWith(root)) {
      throw new BadRequestException("Ruta fuera del workspace.");
    }
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new BadRequestException("Directorio no válido.");
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        const abs = path.join(targetPath, entry.name);
        const relative = normalizeRelative(path.relative(root, abs));
        nodes.push({
          name: entry.name,
          type: "folder",
          relativePath: relative,
          hasChildren: this.folderHasChildren(abs),
        });
        continue;
      }

      if (!entry.isFile() || !TEST_PATTERN.test(entry.name)) {
        continue;
      }
      const abs = path.join(targetPath, entry.name);
      nodes.push({
        name: entry.name,
        type: "file",
        relativePath: normalizeRelative(path.relative(root, abs)),
      });
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async browseFs(targetPath?: string): Promise<{ name: string; type: "folder" | "drive"; path: string }[]> {
    if (!targetPath) {
      // List drives on Windows
      if (process.platform === "win32") {
        return new Promise((resolve) => {
          execFile("wmic", ["logicaldisk", "get", "name"], (error, stdout) => {
            if (error) {
              resolve([{ name: "C:", type: "drive", path: "C:\\" }]);
              return;
            }
            const drives = stdout
              .split("\r\n")
              .filter((line) => line.trim() && !line.includes("Name"))
              .map((line) => {
                const name = line.trim();
                return { name, type: "drive" as const, path: name + "\\" };
              });
            resolve(drives);
          });
        });
      }
      return [{ name: "Root", type: "drive", path: "/" }];
    }

    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new BadRequestException("Ruta inexistente.");
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      throw new BadRequestException("No es un directorio.");
    }

    try {
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          type: "folder" as const,
          path: path.join(resolvedPath, entry.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      throw new BadRequestException("Acceso denegado o error al leer carpeta.");
    }
  }

  private folderHasChildren(folderPath: string): boolean {
    const queue = [folderPath];
    while (queue.length > 0) {
      const current = queue.shift()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) {
            continue;
          }
          queue.push(path.join(current, entry.name));
          continue;
        }
        if (entry.isFile() && TEST_PATTERN.test(entry.name)) {
          return true;
        }
      }
    }
    return false;
  }
}
