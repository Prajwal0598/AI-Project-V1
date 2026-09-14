import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { OpportunityStatus, OpportunityType } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { OpportunityService } from "./opportunity.service";
import { AutomationRuleService } from "./automation-rule.service";
import { SendSuggestionDto, SnoozeOpportunityDto, UpdateSuggestionDto } from "./dto/opportunity-actions.dto";
import { UpdateAutomationRuleDto } from "./dto/update-automation-rule.dto";

@Controller()
export class OpportunityController {
  constructor(
    private readonly opportunities: OpportunityService,
    private readonly automationRules: AutomationRuleService,
  ) {}

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

  @Get("businesses/:businessId/opportunities/analytics")
  analytics(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.opportunities.typeAnalytics(businessId);
  }

  @Get("businesses/:businessId/opportunities/message-performance")
  messagePerformance(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.opportunities.messagePerformance(businessId);
  }

  @Get("businesses/:businessId/opportunities/trends")
  trends(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }, @Query("days") days?: string) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    const parsed = days ? Number(days) : undefined;
    return this.opportunities.trends(businessId, parsed && parsed > 0 && parsed <= 365 ? parsed : undefined);
  }

  @Get("customers/:customerId/best-send-hour")
  bestSendHour(@Param("customerId") customerId: string, @GetUser() user: { businessId: string }) {
    return this.opportunities.inferBestSendHour(user.businessId, customerId);
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

  @Get("businesses/:businessId/automation-rules")
  listRules(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.automationRules.list(businessId);
  }

  @Patch("businesses/:businessId/automation-rules/:type")
  updateRule(@Param("businessId") businessId: string, @Param("type") type: OpportunityType, @GetUser() user: { businessId: string }, @Body() input: UpdateAutomationRuleDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.automationRules.update(businessId, type, input);
  }
}
