import { IsEnum } from "class-validator";
import { ConversationOutcome } from "@prisma/client";

export class UpdateOutcomeDto {
  @IsEnum(ConversationOutcome)
  outcome!: ConversationOutcome;
}
