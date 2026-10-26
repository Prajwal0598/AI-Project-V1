import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";

// ids and references are restricted to a plain character set so a free-text field can never carry personal data into the audit tables
export const ID_PATTERN = /^[A-Za-z0-9_-]{10,40}$/;
export const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{3,64}$/;

export const CALLBACK_KINDS = ["DEAUTHORIZATION", "DATA_DELETION"] as const;
export const CALLBACK_STATUSES = ["PENDING_REVIEW", "COMPLETED", "NO_MATCH", "NO_ACTION_UNVERIFIED", "NO_CHANGE_RECORDED", "NO_DATA_HELD"] as const;

// how a PENDING_REVIEW deletion request can be closed
export const RESOLUTION_OUTCOMES = ["COMPLETED", "NO_DATA_HELD"] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

// how the admin established, off-system and BEFORE this call, that the closure is right — recorded, not performed, by the system
export const RESOLUTION_VERIFICATION_METHODS = ["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS", "RECORDS_SEARCH_NO_MATCH"] as const;
export type ResolutionVerificationMethod = (typeof RESOLUTION_VERIFICATION_METHODS)[number];

export class ListMetaCallbacksQueryDto {
  @IsOptional() @IsIn(CALLBACK_STATUSES)
  status?: (typeof CALLBACK_STATUSES)[number];

  @IsOptional() @IsIn(CALLBACK_KINDS)
  kind?: (typeof CALLBACK_KINDS)[number];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  take?: number;
}

export class PreviewResolutionDto {
  @IsIn(RESOLUTION_OUTCOMES)
  outcome!: ResolutionOutcome;

  // the workspaces whose WhatsApp connection belongs to this Facebook account — required for COMPLETED, forbidden for NO_DATA_HELD
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @Matches(ID_PATTERN, { each: true, message: "each businessId must be a plain id." })
  businessIds?: string[];
}

export class ResolveMetaCallbackDto extends PreviewResolutionDto {
  @IsIn(RESOLUTION_VERIFICATION_METHODS)
  verificationMethod!: ResolutionVerificationMethod;

  @IsString() @Matches(REFERENCE_PATTERN, { message: "resolutionReference must be 3-64 characters from A-Z a-z 0-9 . _ : - (a ticket id, never personal data)." })
  resolutionReference!: string;

  // must equal `RESOLVE <confirmationCode>` exactly
  @IsString() @Matches(/^\S.{0,100}$/, { message: "confirm is required." })
  confirm!: string;
}
