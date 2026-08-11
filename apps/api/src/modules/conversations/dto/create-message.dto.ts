import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { MessageDirection } from "@prisma/client";

export class CreateMessageDto {
  @IsEnum(MessageDirection)
  direction!: MessageDirection;

  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsOptional()
  @IsString()
  providerMessageId?: string;

  @IsOptional()
  @IsISO8601()
  sentAt?: string;
}
