import { IsBoolean, IsOptional } from "class-validator";

export class UpdateCustomerDto {
  @IsOptional()
  @IsBoolean()
  proactiveMessagingOptOut?: boolean;
}
