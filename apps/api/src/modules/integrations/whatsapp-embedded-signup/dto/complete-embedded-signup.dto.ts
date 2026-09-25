import { IsString, MinLength } from "class-validator";

export class CompleteEmbeddedSignupDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  wabaId!: string;

  @IsString()
  @MinLength(1)
  phoneNumberId!: string;
}
