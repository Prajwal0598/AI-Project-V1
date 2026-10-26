import { Body, Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../auth/public.decorator";
import { MetaCallbacksService } from "./meta-callbacks.service";

/**
 * Public by design: Meta calls these server-to-server with no RelayShift login. Authority comes from the HMAC signature on
 * `signed_request`, which is verified with the Meta app secret before anything is read or changed. `signed_request` is read
 * straight off the body (not via a DTO) so extra form fields from Meta can never trip the global whitelist validation.
 */
@Public()
@Controller("integrations/meta")
export class MetaCallbacksController {
  constructor(private readonly callbacks: MetaCallbacksService) {}

  /** "Deauthorize Callback URL": the Facebook user removed RelayShift. Disconnects only what that user authorised. */
  @Post("deauthorize")
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  deauthorize(@Body("signed_request") signedRequest: unknown) {
    return this.callbacks.handleDeauthorization(signedRequest);
  }

  /** "Data Deletion Request URL": responds with `{ url, confirmation_code }` as Meta requires. */
  @Post("data-deletion")
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  dataDeletion(@Body("signed_request") signedRequest: unknown) {
    return this.callbacks.handleDataDeletion(signedRequest);
  }

  /** Read-only status behind the `url` returned above; the confirmation code is the only key. Never cached by a shared proxy. */
  @Get("data-deletion/status/:confirmationCode")
  @Header("Cache-Control", "no-store")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  deletionStatus(@Param("confirmationCode") confirmationCode: string) {
    return this.callbacks.getDeletionStatus(confirmationCode);
  }
}
