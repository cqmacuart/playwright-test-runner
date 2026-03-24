import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export class CreateRunDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  testFiles!: string[];

  @IsIn(["sequential", "parallel"])
  mode!: "sequential" | "parallel";

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(256)
  parallelism?: number;

  /** Ruta absoluta donde guardar el informe HTML unificado (opcional). */
  @IsOptional()
  @IsString()
  reportStoragePath?: string;
}
