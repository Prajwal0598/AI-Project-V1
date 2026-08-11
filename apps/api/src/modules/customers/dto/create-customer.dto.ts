import { IsArray, IsEmail, IsEnum, IsOptional, IsString } from "class-validator";
import { CustomerType } from "@prisma/client";

export class CreateCustomerDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(CustomerType)
  type?: CustomerType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
