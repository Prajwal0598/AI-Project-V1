import type { Logger } from "@nestjs/common";
import { Prisma, WhatsAppConnectionStatus } from "@prisma/client";
import { decryptSecret } from "../../../common/crypto.helper";
import type { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";

/** A connection in one of these states has nothing left to revoke. */
export const NOT_LIVE: WhatsAppConnectionStatus[] = [WhatsAppConnectionStatus.DISCONNECTED, WhatsAppConnectionStatus.DEAUTHORIZED];
export const DEAUTHORIZED_MESSAGE = "Meta reported that the Facebook account that connected WhatsApp removed RelayShift. Connect WhatsApp again to resume.";

export interface RevokedConnection {
  businessId: string;
  wabaId: string | null;
  encryptedToken: string | null;
}

/**
 * Clears the stored Meta credentials of each named business that is still connected and marks it DEAUTHORIZED. The business
 * row, its customers, conversations and orders are not touched. whatsappPhoneNumberId is cleared as well: sends fall back
 * to the shared WHATSAPP_ACCESS_TOKEN when a business has no token of its own, which must never happen for this number.
 * Only the ids passed in are ever written, and each update is guarded so an already-disconnected business is left alone.
 */
export async function revokeConnections(tx: Prisma.TransactionClient, businessIds: string[]): Promise<RevokedConnection[]> {
  const revoked: RevokedConnection[] = [];
  for (const businessId of businessIds) {
    const business = await tx.business.findUnique({ where: { id: businessId }, select: { whatsappBusinessAccountId: true, whatsappAccessTokenEncrypted: true } });
    if (!business) continue;
    const updated = await tx.business.updateMany({
      where: { id: businessId, whatsappConnectionStatus: { notIn: NOT_LIVE } },
      data: {
        whatsappConnectionStatus: WhatsAppConnectionStatus.DEAUTHORIZED,
        whatsappLastErrorMessage: DEAUTHORIZED_MESSAGE,
        whatsappPhoneNumberId: null,
        whatsappBusinessAccountId: null,
        whatsappDisplayPhoneNumber: null,
        metaBusinessId: null,
        whatsappAccessTokenEncrypted: null,
        whatsappConnectedAt: null,
        whatsappLastValidatedAt: null,
      },
    });
    if (updated.count === 1) revoked.push({ businessId, wabaId: business.whatsappBusinessAccountId, encryptedToken: business.whatsappAccessTokenEncrypted });
  }
  return revoked;
}

/** Meta may already have invalidated the token, so this can fail; the credentials are already gone locally either way. */
export async function unsubscribeRevoked(meta: Pick<MetaGraphApiService, "deauthorize">, logger: Logger, revoked: RevokedConnection[]): Promise<void> {
  await Promise.allSettled(
    revoked
      .filter((r) => r.wabaId && r.encryptedToken)
      .map(async (r) => {
        try {
          await meta.deauthorize(r.wabaId as string, decryptSecret(r.encryptedToken as string));
        } catch (err) {
          logger.warn(`Could not unsubscribe the WABA webhook for business ${r.businessId} (${err instanceof Error ? err.name : "UnknownError"})`);
        }
      }),
  );
}
