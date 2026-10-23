import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, Matches } from "class-validator";

// ids and references are restricted to a plain character set so a free-text field can never carry personal data into the audit table
const ID_PATTERN = /^[A-Za-z0-9_-]{10,40}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{3,64}$/;

export const ERASURE_REQUESTERS = ["CUSTOMER", "MERCHANT"] as const;
export type ErasureRequester = (typeof ERASURE_REQUESTERS)[number];

// how the requester's identity/authority was verified by a human BEFORE this call — the system records it, it cannot perform it
export const ERASURE_VERIFICATION_METHODS = [
  "REPLY_FROM_CUSTOMER_CHANNEL",
  "EMAIL_FROM_REGISTERED_ADDRESS",
  "MERCHANT_WRITTEN_AUTHORISATION",
  "ONE_TIME_CODE_OR_CALLBACK",
] as const;
export type ErasureVerificationMethod = (typeof ERASURE_VERIFICATION_METHODS)[number];

export class PreviewErasureDto {
  @IsString() @Matches(ID_PATTERN, { message: "businessId is not a valid id." })
  businessId!: string;

  @IsString() @Matches(ID_PATTERN, { message: "customerId is not a valid id." })
  customerId!: string;
}

export class ExecuteErasureDto extends PreviewErasureDto {
  @IsString() @Matches(REFERENCE_PATTERN, { message: "requestReference must be 3-64 characters from A-Z a-z 0-9 . _ : - (a ticket id, never personal data)." })
  requestReference!: string;

  @IsIn(ERASURE_REQUESTERS)
  requestedBy!: ErasureRequester;

  @IsIn(ERASURE_VERIFICATION_METHODS)
  verificationMethod!: ErasureVerificationMethod;

  // must equal `ERASE <customerId>` exactly
  @IsString() @IsNotEmpty()
  confirm!: string;

  // required when the customer still has an unpaid, unapproved or undelivered order, because the delivery address is erased
  @IsOptional() @IsBoolean()
  acknowledgeOpenOrders?: boolean;
}
