import { BadRequestException, Injectable } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { ensureInsideRoot, normalizeRelative } from "../common/path-utils";
import { WorkspaceService } from "../workspace/workspace.service";

export type NameSuggestion = {
  file: string;
  currentName: string;
  suggestedName: string;
  reason: string;
};

@Injectable()
export class TestsService {
  constructor(private readonly workspaceService: WorkspaceService) {}

  getNameSuggestions(files: string[]): NameSuggestion[] {
    const suggestions: NameSuggestion[] = [];
    for (const file of files) {
      const normalized = normalizeRelative(file);
      const suggestedName = this.buildSuggestionName(path.basename(normalized));
      const currentName = path.basename(normalized);
      if (!suggestedName || suggestedName === currentName) {
        continue;
      }
      suggestions.push({
        file: normalized,
        currentName,
        suggestedName: normalizeRelative(path.join(path.dirname(normalized), suggestedName)),
        reason: "Normalizar a kebab-case y sufijo .spec.ts",
      });
    }
    return suggestions;
  }

  renameTestFile(from: string, to: string): void {
    const root = this.workspaceService.getWorkspaceRoot();
    const fromAbs = this.workspaceService.resolveAbsolute(from);
    const toAbs = this.workspaceService.resolveAbsolute(to);

    if (!ensureInsideRoot(root, fromAbs) || !ensureInsideRoot(root, toAbs)) {
      throw new BadRequestException("Ruta fuera del workspace.");
    }
    if (!fs.existsSync(fromAbs) || !fs.statSync(fromAbs).isFile()) {
      throw new BadRequestException("Archivo origen no válido.");
    }
    if (fs.existsSync(toAbs)) {
      throw new BadRequestException("El archivo destino ya existe.");
    }

    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
  }

  private buildSuggestionName(fileName: string): string | null {
    const extMatch = fileName.match(/\.(spec|test)\.ts$/i);
    const base = extMatch
      ? fileName.replace(/\.(spec|test)\.ts$/i, "")
      : fileName.replace(/\.ts$/i, "");
    const kebab = base
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    if (!kebab) {
      return null;
    }
    return `${kebab}.spec.ts`;
  }
}
