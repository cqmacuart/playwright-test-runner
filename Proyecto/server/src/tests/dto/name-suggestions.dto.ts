import { ArrayNotEmpty, IsArray, IsString } from "class-validator";

export class NameSuggestionsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  files!: string[];
}
