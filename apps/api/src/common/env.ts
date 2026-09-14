export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Fails fast on startup rather than silently running with an insecure/missing secret. */
export function assertRequiredEnv(): void {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    console.error(
      "[bootstrap] JWT_SECRET is missing or too short (must be at least 32 characters) — refusing to start.\n" +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\" and set it in .env",
    );
    process.exit(1);
  }
}
