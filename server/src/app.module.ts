import { Module } from "@nestjs/common";
import { RunsModule } from "./runs/runs.module";
import { TestsModule } from "./tests/tests.module";
import { WorkspaceModule } from "./workspace/workspace.module";

@Module({
  imports: [WorkspaceModule, TestsModule, RunsModule],
})
export class AppModule {}
