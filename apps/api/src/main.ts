import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory, HttpAdapterHost } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { config } from "dotenv";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { assertRequiredEnv } from "./common/env";
import { resolveCors } from "./common/cors.helper";
import { initErrorReporting } from "./common/error-reporting.helper";
import { SentryExceptionFilter } from "./common/sentry-exception.filter";

async function bootstrap() {
  for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (existsSync(path)) config({ path, override: false });
  }
  assertRequiredEnv();
  initErrorReporting();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix("api");
  // default "same-origin" CORP blocks the browser (not curl) from loading uploaded product images
  // from the API's origin (:4000) when embedded in the web app (:3000) via <img>
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  const cors = resolveCors(process.env.WEB_ORIGIN);
  if (cors.ignored.length) console.warn(`[bootstrap] Ignoring WEB_ORIGIN entries that are not exact http(s) origins (a wildcard is never allowed): ${cors.ignored.join(", ")}`);
  if (!cors.origins.length) console.error("[bootstrap] WEB_ORIGIN has no valid origin — browsers will be blocked by CORS until it is fixed");
  else console.log(`[bootstrap] CORS allows: ${cors.origins.join(", ")}`);
  app.enableCors(cors.options);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new SentryExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT) || 4000);
}

bootstrap().catch((err) => {
  console.error("[bootstrap] Fatal startup error", err);
  process.exit(1);
});
