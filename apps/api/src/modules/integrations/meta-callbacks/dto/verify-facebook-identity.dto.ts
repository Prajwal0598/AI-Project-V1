import { IsString, MaxLength, MinLength } from "class-validator";

export class VerifyFacebookIdentityDto {
  // the short-lived authorization code from FB.login (response_type: "code"); exchanged server-side, never a user id
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  code!: string;
}
