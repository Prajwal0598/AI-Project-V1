import { Controller, Param, Post } from "@nestjs/common";
import { AiService } from "./ai.service";

@Controller("conversations/:conversationId")
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Generates and stores a draft only. It never sends a message to a channel. */
  @Post("ai-draft")
  draftReply(@Param("conversationId") conversationId: string) {
    return this.ai.createReplyDraft(conversationId);
  }
}
