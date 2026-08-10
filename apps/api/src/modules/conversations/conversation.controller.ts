import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ConversationService, CreateConversationInput, CreateMessageInput } from "./conversation.service";

@Controller()
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Post("customers/:customerId/conversations")
  create(@Param("customerId") customerId: string, @Body() input: CreateConversationInput) {
    return this.conversations.create(customerId, input);
  }

  @Get("conversations/:conversationId")
  get(@Param("conversationId") conversationId: string) {
    return this.conversations.get(conversationId);
  }

  @Post("conversations/:conversationId/messages")
  addMessage(@Param("conversationId") conversationId: string, @Body() input: CreateMessageInput) {
    return this.conversations.addMessage(conversationId, input);
  }
}
