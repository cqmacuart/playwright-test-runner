import { IsNotEmpty, IsString } from "class-validator";

export class SelectWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  repoPath!: string;
}
