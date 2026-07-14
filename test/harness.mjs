/**
 * Shared Miniflare wiring for the integration tests.
 *
 * The Worker now imports an npm package (workers-og) that ships WASM, and
 * Miniflare cannot load src/index.js directly ("you'll need to bundle your Worker
 * first"). So we bundle the Worker with wrangler, exactly as production does, and
 * point Miniflare at the output plus a CompiledWasm module rule for the resvg/yoga
 * .wasm files. `npm test` builds the bundle once via the `pretest` script;
 * ensureBundle() below is a guard so running a single test file directly still
 * works (and rebuilds when a source file changed).
 */
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUTDIR = ".wrangler/test-build";

export const WORKER_SCRIPT = `${root}${OUTDIR}/index.js`;
export const MODULE_RULES = [{ type: "CompiledWasm", include: ["**/*.wasm"] }];

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
