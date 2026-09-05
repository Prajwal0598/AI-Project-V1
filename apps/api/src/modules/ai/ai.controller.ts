import { Controller, Param, Post } from "@nestjs/common";
import { AiService } from "./ai.service";

@Controller("conversations/:conversationId")
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Generates a reply and sends it immediately via the conversation's channel — no approval step. */
  @Post("ai-draft")
  draftReply(@Param("conversationId") conversationId: string) {
    return this.ai.generateAndSendReply(conversationId);
  }
}
