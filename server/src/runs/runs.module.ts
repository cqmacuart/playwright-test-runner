import { Module } from "@nestjs/common";
import { WorkspaceModule } from "../workspace/workspace.module";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";

@Module({
  imports: [WorkspaceModule],
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
