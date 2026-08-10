import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { config } from "dotenv";
import { AppModule } from "./app.module";

async function bootstrap() {
  for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
    if (existsSync(path)) config({ path, override: false });
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(",") ?? "http://localhost:3000",
    credentials: true
  });
  await app.listen(Number(process.env.PORT ?? 4000));
}

void bootstrap();
