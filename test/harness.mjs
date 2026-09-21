/**
 * Shared Miniflare wiring for the integration tests.
 *
 * The Worker now imports an npm package (workers-og) that ships WASM, and
 * Miniflare cannot load src/index.js directly ("you'll need to bundle your Worker
 * first"). So we bundle the Worker with wrangler, exactly as production does, and
 * point Miniflare at the output: the bundle's entry module plus the resvg/yoga
 * .wasm files it imports. `npm test` builds the bundle once via the `pretest`
 * script; ensureBundle() below is a guard so running a single test file directly
 * still works (and rebuilds when a source file changed).
 *
 * Miniflare 5 replaced its constructor options with a `workers: [...]` shape and
 * no longer discovers modules through `modulesRules`. The test files keep writing
 * the familiar single-worker (v4) options, spread workerSource() in for the
 * explicit module list, and build their instance through createMiniflare(),
 * which converts with Miniflare's own convertV4MiniflareOptions().
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUTDIR = ".wrangler/test-build";
const BUNDLE_DIR = `${root}${OUTDIR}`;

export const WORKER_SCRIPT = `${BUNDLE_DIR}/index.js`;

const SOURCES = ["src/index.js", "shared/scan-core.mjs"].map((p) => `${root}${p}`);

export function ensureBundle() {
  const bundleReady =
    existsSync(WORKER_SCRIPT) &&
    SOURCES.every((src) => statSync(WORKER_SCRIPT).mtimeMs >= statSync(src).mtimeMs);
  if (bundleReady) return;
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", OUTDIR], {
    cwd: root,
    stdio: "ignore",
  });
}

/**
 * The bundled Worker as Miniflare module options: the entry module first, then
 * the .wasm files it imports, named relative to the bundle directory (the same
 * relative specifiers the bundle uses to import them).
 */
export function workerSource() {
  ensureBundle();
  const wasm = readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".wasm"));
  return {
    modulesRoot: BUNDLE_DIR,
    modules: [
      { type: "ESModule", path: WORKER_SCRIPT },
      ...wasm.map((f) => ({ type: "CompiledWasm", path: join(BUNDLE_DIR, f) })),
    ],
  };
}

/** A Miniflare instance from v4-style single-worker options. */
export function createMiniflare(options) {
  return new Miniflare(convertV4MiniflareOptions(options));
}
