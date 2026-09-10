import { IsEnum } from "class-validator";
import { FulfillmentStatus } from "@prisma/client";

export class UpdateFulfillmentStatusDto {
  @IsEnum(FulfillmentStatus)
  fulfillmentStatus!: FulfillmentStatus;
}
