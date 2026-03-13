import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { SelectWorkspaceDto } from "./dto/select-workspace.dto";
import { WorkspaceService } from "./workspace.service";

@Controller("api/workspace")
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post("select")
  select(@Body() body: SelectWorkspaceDto): { ok: true } {
    this.workspaceService.selectWorkspace(body.repoPath);
    return { ok: true };
  }

  @Post("pick")
  async pick(): Promise<{ path: string | null }> {
    const path = await this.workspaceService.pickWorkspaceFolder();
    return { path };
  }

  @Get("tree")
  tree(@Query("relativePath") relativePath?: string): { nodes: ReturnType<WorkspaceService["listTree"]> } {
    const nodes = this.workspaceService.listTree(relativePath ?? "");
    return { nodes };
  }
}
