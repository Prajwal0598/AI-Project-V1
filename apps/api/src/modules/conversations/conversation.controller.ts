import { Body, Controller, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { ConversationService } from "./conversation.service";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { CreateMessageDto } from "./dto/create-message.dto";
import { SendMessageDto } from "./dto/send-message.dto";

@Controller()
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Get("businesses/:businessId/conversations")
  list(@Param("businessId") businessId: string, @GetUser() user: User) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.conversations.list(businessId);
  }

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

  @Post("conversations/:conversationId/send")
  sendMessage(@Param("conversationId") conversationId: string, @GetUser() user: User, @Body() input: SendMessageDto) {
    return this.conversations.sendMessage(conversationId, user.businessId, input.content);
  }
}
