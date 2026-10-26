import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../database/prisma.service";
import { isValidMetaUserId } from "../../../common/meta-signed-request.helper";

/** The id is the app-scoped id of the business integration's system user, read from Meta with the business token (GET /me). */
export const LINK_SOURCE_SYSTEM_USER = "ES_SYSTEM_USER";
/** The id is the app-scoped id of the person, read by inspecting a user token Meta issued to them (GET /debug_token). */
export const LINK_SOURCE_FACEBOOK_USER = "FACEBOOK_LOGIN_USER_TOKEN";

/**
 * Records which Meta app-scoped ids stand behind a business's WhatsApp connection, so Meta's deauthorization and
 * data-deletion callbacks — which identify a person only by that id — can find the right business.
 *
 * An id is accepted ONLY when this server obtained it from Meta itself (using the business token, or a login code the
 * server exchanged and then inspected). A user id sent by a browser is never trusted: the callbacks act on whoever this
 * table says owns an id, so a forged link could aim another merchant's data deletion at the wrong workspace.
 *
 * Links describe the CURRENT connection. A new Embedded Signup replaces them all, and credentials typed in by hand
 * (BusinessService.update) supersede them, so an older authoriser can never disconnect a newer connection.
 */
@Injectable()
export class MetaUserLinkService {
  private readonly logger = new Logger(MetaUserLinkService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A new connection was just stored: every earlier link described the old one, so retire them, then record the system user
   * behind the new token when Meta told us who it is. Never throws — a missing association must not fail the onboarding.
   */
  async replaceConnectionLinks(businessId: string, systemUserId: string | null): Promise<boolean> {
    try {
      await this.prisma.metaUserLink.updateMany({ where: { businessId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "SUPERSEDED" } });
      return systemUserId ? await this.upsertLink(businessId, systemUserId, LINK_SOURCE_SYSTEM_USER) : false;
    } catch (err) {
      this.logger.error(`Could not update the Meta links for business ${businessId} (${err instanceof Error ? err.name : "UnknownError"})`);
      return false;
    }
  }

  /** A person proved, through a Meta-issued token this server inspected, that they own `userId`. */
  async recordVerifiedUser(businessId: string, userId: string): Promise<boolean> {
    return this.upsertLink(businessId, userId, LINK_SOURCE_FACEBOOK_USER);
  }

  private async upsertLink(businessId: string, metaUserId: string, source: string): Promise<boolean> {
    if (!isValidMetaUserId(metaUserId)) {
      this.logger.warn(`Ignored a Meta id of an unexpected shape while linking business ${businessId}`);
      return false;
    }
    await this.prisma.metaUserLink.upsert({
      where: { businessId_metaUserId: { businessId, metaUserId } },
      create: { businessId, metaUserId, source },
      update: { revokedAt: null, revokedReason: null, source },
    });
    return true;
  }
}
