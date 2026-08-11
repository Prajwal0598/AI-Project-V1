import { IsEnum, IsOptional, IsString } from "class-validator";
import { Channel } from "@prisma/client";

export class CreateConversationDto {
  @IsEnum(Channel)
  channel!: Channel;

  @IsOptional()
  @IsString()
  identityId?: string;

  @IsOptional()
  @IsString()
  title?: string;
}
