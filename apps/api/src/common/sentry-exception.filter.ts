import { ArgumentsHost, Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { captureException } from "./error-reporting.helper";

/** Reports every unhandled exception to Sentry (if configured) before delegating to Nest's normal error
 * response handling — expected 4xx HttpExceptions (validation, ForbiddenException, NotFoundException, etc.)
 * are still reported but are far less interesting than a genuine 5xx; Sentry's own issue grouping handles that. */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) captureException(exception);
    super.catch(exception, host);
  }
}
