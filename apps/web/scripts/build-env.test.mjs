import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Guards the production build-time plumbing for Meta WhatsApp Embedded Signup. Next.js inlines NEXT_PUBLIC_* values at BUILD time,
// and Railway only passes a service variable to a Dockerfile build when the Dockerfile declares it with ARG — so a missing ARG
// silently ships a bundle with the Connect WhatsApp button disabled. Plain node:test, no dependencies, run by `pnpm test`.

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webDir, "..", "..");
const dockerfile = readFileSync(join(webDir, "Dockerfile"), "utf8");

const PUBLIC_META_VARS = ["NEXT_PUBLIC_META_APP_ID", "NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID"];
const NEVER_IN_THE_BROWSER = ["WHATSAPP_APP_SECRET", "INSTAGRAM_APP_SECRET", "META_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "CREDENTIALS_ENCRYPTION_KEY", "JWT_SECRET"];

/** The instructions of the stage that runs `next build` (from `FROM ... AS build` up to the next FROM), continuation lines joined. */
function buildStage() {
  const lines = dockerfile.replace(/\\\n\s*/g, " ").split("\n");
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+build\b/i.test(l));
  assert.notEqual(start, -1, "the Dockerfile must have a stage named build");
  const next = lines.findIndex((l, i) => i > start && /^FROM\s/i.test(l));
  return lines.slice(start, next === -1 ? undefined : next);
}

const instruction = (stage, pattern) => stage.findIndex((l) => pattern.test(l.trim()));

test("the build stage declares every public Meta variable as an ARG, so Railway passes it to the build", () => {
  const stage = buildStage();
  for (const name of ["NEXT_PUBLIC_API_URL", ...PUBLIC_META_VARS]) {
    assert.notEqual(instruction(stage, new RegExp(`^ARG\\s+${name}(=|$)`)), -1, `missing "ARG ${name}" in the build stage`);
  }
});

test("each ARG is exported as an ENV in the build stage, so next build can read it", () => {
  const stage = buildStage();
  for (const name of ["NEXT_PUBLIC_API_URL", ...PUBLIC_META_VARS]) {
    assert.notEqual(instruction(stage, new RegExp(`^ENV\\s.*\\b${name}=\\$${name}\\b`)), -1, `missing "ENV ${name}=$${name}" in the build stage`);
  }
});

test("the ARGs and ENVs come before the step that runs next build", () => {
  const stage = buildStage();
  const build = instruction(stage, /^RUN\s+pnpm\s+--filter\s+\S+\s+build\b/);
  assert.notEqual(build, -1, "the build stage must run the web build");
  for (const name of PUBLIC_META_VARS) {
    const arg = instruction(stage, new RegExp(`^ARG\\s+${name}\\b`));
    const env = instruction(stage, new RegExp(`^ENV\\s.*\\b${name}=\\$${name}\\b`));
    assert.ok(arg !== -1 && arg < build, `ARG ${name} must precede the build step`);
    assert.ok(env !== -1 && env < build, `ENV ${name} must precede the build step`);
  }
});

test("the Meta ARGs default to empty, so an unconfigured build reports the setup as missing instead of using a stale value", () => {
  for (const name of PUBLIC_META_VARS) assert.match(dockerfile, new RegExp(`^ARG\\s+${name}=\\s*$`, "m"));
});

test("the Dockerfile never declares a Meta secret or token, in any stage", () => {
  const declared = dockerfile.split("\n").filter((l) => /^\s*(ARG|ENV)\b/.test(l)).join("\n");
  for (const name of NEVER_IN_THE_BROWSER) assert.ok(!declared.includes(name), `${name} must not be an ARG/ENV in the web image`);
  assert.doesNotMatch(declared, /NEXT_PUBLIC_\w*(SECRET|TOKEN|PASSWORD|PRIVATE)/i, "no NEXT_PUBLIC_ variable may carry a secret");
});

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === ".next" ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

test("client-side code reads no environment variable except NEXT_PUBLIC_* and NODE_ENV", () => {
  const offenders = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sourceFiles(join(webDir, dir))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
        if (!m[1].startsWith("NEXT_PUBLIC_") && m[1] !== "NODE_ENV") offenders.push(`${relative(webDir, file)}: process.env.${m[1]}`);
      }
      for (const name of NEVER_IN_THE_BROWSER) if (new RegExp(`process\\.env\\[?["'.]?${name}`).test(text)) offenders.push(`${relative(webDir, file)}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no NEXT_PUBLIC_ variable name in the web source or the env template suggests a secret", () => {
  const names = new Set();
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sourceFiles(join(webDir, dir))) for (const m of readFileSync(file, "utf8").matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  for (const m of readFileSync(join(repoRoot, ".env.example"), "utf8").matchAll(/^\s*#?\s*(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)) names.add(m[1]);
  assert.ok(names.has("NEXT_PUBLIC_META_APP_ID") && names.has("NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID"));
  for (const name of names) assert.doesNotMatch(name, /SECRET|TOKEN|PASSWORD|PRIVATE/, `${name} would put a secret in the browser bundle`);
});

test(".env.example documents the same variables the Dockerfile and the API read", () => {
  const template = readFileSync(join(repoRoot, ".env.example"), "utf8");
  for (const name of [...PUBLIC_META_VARS, "META_APP_ID", "WHATSAPP_APP_SECRET"]) assert.match(template, new RegExp(`^${name}=`, "m"), `${name} missing from .env.example`);
});

test("the settings page reads the same variable names the Dockerfile declares", () => {
  const settings = readFileSync(join(webDir, "app", "settings", "page.tsx"), "utf8");
  for (const name of PUBLIC_META_VARS) assert.ok(settings.includes(`process.env.${name}`), `settings/page.tsx must read process.env.${name}`);
});
