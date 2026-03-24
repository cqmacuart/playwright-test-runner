import { Module } from "@nestjs/common";
import { WorkspaceModule } from "../workspace/workspace.module";
import { TestsController } from "./tests.controller";
import { TestsService } from "./tests.service";

@Module({
  imports: [WorkspaceModule],
  controllers: [TestsController],
  providers: [TestsService],
  exports: [TestsService],
})
export class TestsModule {}
