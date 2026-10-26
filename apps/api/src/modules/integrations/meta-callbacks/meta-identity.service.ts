import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { isValidMetaUserId } from "../../../common/meta-signed-request.helper";
import { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import { readMetaAppConfig } from "./meta-app-config";
import { MetaUserLinkService } from "./meta-user-link.service";

/**
 * Lets a signed-in merchant prove, through Facebook Login for Business, which Facebook account they are, so that Meta's
 * deauthorization and data-deletion callbacks for that account can find this workspace.
 *
 * Nothing the browser reports about identity is believed. The browser hands over only the short-lived authorization code
 * from a "User access token" configuration; this server exchanges it, asks Meta (GET /debug_token) which app issued the
 * token and whose it is, and uses that answer. The user token itself is discarded immediately — never stored, never logged.
 */
@Injectable()
export class MetaIdentityService {
  constructor(
    private readonly meta: MetaGraphApiService,
    private readonly links: MetaUserLinkService,
  ) {}

  async verifyAndLink(businessId: string, code: string): Promise<{ verified: true }> {
    const { appId, appSecret } = readMetaAppConfig();
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException(`Facebook account verification is not configured on the server. Missing: ${[!appId && "META_APP_ID", !appSecret && "WHATSAPP_APP_SECRET"].filter(Boolean).join(", ")}.`);
    }

    const token = await this.meta.exchangeCodeForToken(code);
    const inspected = await this.meta.debugToken(token);
    // the token must be valid, issued to THIS app, and be a personal (USER) token — a system-user token says nothing about a person
    if (!inspected.isValid || inspected.appId !== appId || inspected.type !== "USER" || !isValidMetaUserId(inspected.userId)) {
      throw new BadRequestException("Meta could not confirm this Facebook login. Please try again with your personal Facebook account.");
    }

    await this.links.recordVerifiedUser(businessId, inspected.userId);
    return { verified: true };
  }
}
