import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { OpportunityStatus } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { OpportunityService } from "./opportunity.service";
import { SendSuggestionDto, SnoozeOpportunityDto, UpdateSuggestionDto } from "./dto/opportunity-actions.dto";

@Controller()
export class OpportunityController {
  constructor(private readonly opportunities: OpportunityService) {}

  @Get("businesses/:businessId/opportunities")
  async list(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }, @Query("status") status?: OpportunityStatus) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    await this.opportunities.wakeSnoozed(businessId);
    return this.opportunities.listInbox(businessId, status);
  }

  @Get("businesses/:businessId/opportunities/summary")
  summary(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.opportunities.summary(businessId);
  }

  @Post("opportunities/:id/send")
  send(@Param("id") id: string, @GetUser() user: { businessId: string }, @Body() input: SendSuggestionDto) {
    return this.opportunities.send(id, user.businessId, input.editedMessage);
  }

  @Patch("opportunities/:id/message")
  updateMessage(@Param("id") id: string, @GetUser() user: { businessId: string }, @Body() input: UpdateSuggestionDto) {
    return this.opportunities.updateMessage(id, user.businessId, input.message);
  }

  @Post("opportunities/:id/dismiss")
  dismiss(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.opportunities.dismiss(id, user.businessId);
  }

  @Post("opportunities/:id/snooze")
  snooze(@Param("id") id: string, @GetUser() user: { businessId: string }, @Body() input: SnoozeOpportunityDto) {
    return this.opportunities.snooze(id, user.businessId, input.hours);
  }
}
