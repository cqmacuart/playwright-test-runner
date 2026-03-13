import { Body, Controller, Post } from "@nestjs/common";
import { NameSuggestionsDto } from "./dto/name-suggestions.dto";
import { RenameTestDto } from "./dto/rename-test.dto";
import { TestsService } from "./tests.service";

@Controller("api/tests")
export class TestsController {
  constructor(private readonly testsService: TestsService) {}

  @Post("suggestions")
  suggestions(@Body() body: NameSuggestionsDto): { suggestions: ReturnType<TestsService["getNameSuggestions"]> } {
    const suggestions = this.testsService.getNameSuggestions(body.files);
    return { suggestions };
  }

  @Post("rename")
  rename(@Body() body: RenameTestDto): { ok: true } {
    this.testsService.renameTestFile(body.from, body.to);
    return { ok: true };
  }
}
