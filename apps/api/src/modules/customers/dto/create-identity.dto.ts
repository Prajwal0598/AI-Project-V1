import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { Channel } from "@prisma/client";

export class CreateIdentityDto {
  @IsEnum(Channel)
  channel!: Channel;

  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
