import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { Channel } from "@prisma/client";

export class CreateConversationDto {
  @IsEnum(Channel)
  channel!: Channel;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  identityId?: string;

  @IsOptional()
  @IsString()
  title?: string;
}
