import { IsNotEmpty, IsString } from "class-validator";

export class RenameTestDto {
  @IsString()
  @IsNotEmpty()
  from!: string;

  @IsString()
  @IsNotEmpty()
  to!: string;
}
