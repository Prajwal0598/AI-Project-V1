import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { META_GRAPH_API_VERSION, META_GRAPH_BASE_URL } from "./meta-graph";

// Every outbound Meta call (API, worker, browser SDK) must use ONE Graph API version, and it must be a supported one.
// Meta serves an expired version on the next usable one without telling you, so a stray old literal is a silent bug.

const REPO_ROOT = join(__dirname, "../../../..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/** Graph API v21.0 is removed on 21 Jan 2027 and v20.0 already was (v26.0 changelog, "API Version Deprecations"). */
const OLDEST_ACCEPTABLE_MAJOR = 22;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ["node_modules", ".next", "dist"].includes(name) ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

describe("Meta Graph API version", () => {
  it("is a supported version", () => {
    expect(META_GRAPH_API_VERSION).toMatch(/^v\d+\.0$/);
    expect(Number(META_GRAPH_API_VERSION.slice(1).split(".")[0])).toBeGreaterThanOrEqual(OLDEST_ACCEPTABLE_MAJOR);
  });

  it("builds the base URL from that version", () => {
    expect(META_GRAPH_BASE_URL).toBe(`https://graph.facebook.com/${META_GRAPH_API_VERSION}`);
  });

  it("is the same constant in the worker and the web app", () => {
    expect(read("apps/worker/src/meta-graph.ts")).toContain(`META_GRAPH_API_VERSION = "${META_GRAPH_API_VERSION}"`);
    expect(read("apps/web/lib/meta-graph.ts")).toContain(`META_GRAPH_API_VERSION = "${META_GRAPH_API_VERSION}"`);
  });

  it("is used by the browser SDK init, not a literal", () => {
    const settings = read("apps/web/app/settings/page.tsx");
    expect(settings).toMatch(/FB\?\.init\(\{[^}]*version: META_GRAPH_API_VERSION/);
    expect(settings).not.toMatch(/version: "v\d/);
  });

  it("is the only place a graph.facebook.com URL or a version literal is written in API, worker or web source", () => {
    const allowed = new Set(["apps/api/src/common/meta-graph.ts", "apps/worker/src/meta-graph.ts", "apps/web/lib/meta-graph.ts"]);
    const offenders: string[] = [];
    for (const dir of ["apps/api/src", "apps/worker/src", "apps/web/app", "apps/web/lib", "apps/web/components"]) {
      for (const file of sourceFiles(join(REPO_ROOT, dir))) {
        const rel = relative(REPO_ROOT, file);
        if (allowed.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        if (/graph\.facebook\.com/.test(text)) offenders.push(`${rel}: hard-coded graph.facebook.com`);
        if (/["'`/]v(19|2\d)\.0["'`/]/.test(text)) offenders.push(`${rel}: hard-coded Graph version literal`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
