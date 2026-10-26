import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { ID_PATTERN, REFERENCE_PATTERN } from "./meta-callback-admin.dto";

// the review queue is NO_ACTION_UNVERIFIED; the other statuses are readable so a closed event can be looked up
export const DEAUTH_LIST_STATUSES = ["NO_ACTION_UNVERIFIED", "COMPLETED", "NO_CHANGE_RECORDED", "NO_MATCH"] as const;

export const DEAUTH_OUTCOMES = ["DISCONNECT_VERIFIED", "NO_CHANGE"] as const;
export type DeauthOutcome = (typeof DEAUTH_OUTCOMES)[number];

// how the admin established, off-system and BEFORE this call, what the closure rests on — recorded, not performed, by the system
export const DEAUTH_VERIFICATION_METHODS = ["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS", "RECORDS_REVIEW"] as const;
export type DeauthVerificationMethod = (typeof DEAUTH_VERIFICATION_METHODS)[number];
// a disconnect needs the merchant's own confirmation; the admin's reading of our records alone is never enough to disconnect
export const DEAUTH_DISCONNECT_METHODS: readonly DeauthVerificationMethod[] = ["MERCHANT_WRITTEN_CONFIRMATION", "EMAIL_FROM_REGISTERED_ADDRESS"];

// fixed codes, not free text, so the audit tables can never carry personal data
export const DEAUTH_NO_CHANGE_REASONS = ["IDENTITY_NOT_ESTABLISHED", "MERCHANT_CONFIRMED_KEEP_CONNECTED", "CONNECTION_ALREADY_REPLACED", "SUPERSEDED_BY_DATA_DELETION"] as const;
export type DeauthNoChangeReason = (typeof DEAUTH_NO_CHANGE_REASONS)[number];

export const DEAUTH_RESOLVED_STATUS: Record<DeauthOutcome, string> = { DISCONNECT_VERIFIED: "COMPLETED", NO_CHANGE: "NO_CHANGE_RECORDED" };

export class ListDeauthorizationsQueryDto {
  @IsOptional() @IsIn(DEAUTH_LIST_STATUSES)
  status?: (typeof DEAUTH_LIST_STATUSES)[number];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  take?: number;
}

export class PreviewDeauthorizationDto {
  @IsIn(DEAUTH_OUTCOMES)
  outcome!: DeauthOutcome;

  // the candidate businesses whose connection the admin independently verified — required for DISCONNECT_VERIFIED, forbidden for NO_CHANGE
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true }) @Matches(ID_PATTERN, { each: true, message: "each businessId must be a plain id." })
  businessIds?: string[];
}

export class ResolveDeauthorizationDto extends PreviewDeauthorizationDto {
  @IsIn(DEAUTH_VERIFICATION_METHODS)
  verificationMethod!: DeauthVerificationMethod;

  @IsString() @Matches(REFERENCE_PATTERN, { message: "resolutionReference must be 3-64 characters from A-Z a-z 0-9 . _ : - (a ticket id, never personal data)." })
  resolutionReference!: string;

  // the documented reason a connection was left unchanged — required for NO_CHANGE, forbidden for DISCONNECT_VERIFIED
  @IsOptional() @IsIn(DEAUTH_NO_CHANGE_REASONS)
  reason?: DeauthNoChangeReason;

  // must equal `<outcome> <requestId>` exactly
  @IsString() @Matches(/^\S.{0,100}$/, { message: "confirm is required." })
  confirm!: string;
}
