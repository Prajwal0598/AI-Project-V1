import { Controller, Param, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { AiService } from "./ai.service";

@Controller("conversations/:conversationId")
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Generates a reply and sends it immediately via the conversation's channel — no approval step. */
  @Post("ai-draft")
  draftReply(@Param("conversationId") conversationId: string, @GetUser() user: User) {
    return this.ai.generateAndSendReply(conversationId, user.businessId);
  }
}
