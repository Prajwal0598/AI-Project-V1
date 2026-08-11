import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ConversationService } from "./conversation.service";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { CreateMessageDto } from "./dto/create-message.dto";

@Controller()
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Post("customers/:customerId/conversations")
  create(@Param("customerId") customerId: string, @Body() input: CreateConversationDto) {
    return this.conversations.create(customerId, input);
  }

  @Get("conversations/:conversationId")
  get(@Param("conversationId") conversationId: string) {
    return this.conversations.get(conversationId);
  }

  @Post("conversations/:conversationId/messages")
  addMessage(@Param("conversationId") conversationId: string, @Body() input: CreateMessageDto) {
    return this.conversations.addMessage(conversationId, input);
  }
}
