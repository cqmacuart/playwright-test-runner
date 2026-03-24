import { Controller, Get, MessageEvent, Param, Post, Body, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { CreateRunDto } from "./dto/create-run.dto";
import { RunsService } from "./runs.service";
import { RunEvent } from "./runs.types";

@Controller("api/runs")
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Post()
  create(@Body() body: CreateRunDto): ReturnType<RunsService["createRun"]> {
    return this.runsService.createRun(body);
  }

  @Get(":runId")
  get(@Param("runId") runId: string): ReturnType<RunsService["getRun"]> {
    return this.runsService.getRun(runId);
  }

  @Post(":runId/stop")
  async stop(@Param("runId") runId: string): Promise<{ ok: true }> {
    await this.runsService.stopRun(runId);
    return { ok: true };
  }

  @Post(":runId/items/:itemId/stop")
  async stopItem(@Param("runId") runId: string, @Param("itemId") itemId: string): Promise<{ ok: true }> {
    await this.runsService.stopRunItem(runId, itemId);
    return { ok: true };
  }

  @Sse(":runId/stream")
  stream(@Param("runId") runId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const emitter = this.runsService.getEmitter(runId);
      const handler = (event: RunEvent) => subscriber.next({ data: event });
      emitter.on("event", handler);
      return () => {
        emitter.off("event", handler);
      };
    });
  }
}
