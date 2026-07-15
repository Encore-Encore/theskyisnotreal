/**
 * Build step: copy ./public -> ./dist, then content-hash the CSS/JS bundles
 * into /assets/ and rewrite every HTML reference to point at the hashed name.
 *
 * Because a hashed filename changes whenever its contents change, the Worker can
 * serve /assets/* with `Cache-Control: immutable` (see src/index.js) without ever
 * risking a stale bundle after a deploy. Everything else in ./public is copied
 * through untouched. Wrangler runs this automatically before `dev` and `deploy`
 * via the `build.command` hook in wrangler.jsonc.
 *
 * The whole tree is built in a sibling temp directory and swapped into place with
 * a single rename, so a concurrently-running `wrangler dev` never observes a
 * missing or half-written ./dist (which otherwise made it 500 mid-rebuild). The
 * temp dir must be a sibling of ./dist so the swap stays a same-filesystem rename.
 */
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdirSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "public");
const OUT = join(ROOT, "dist");

const TMP_PREFIX = "dist.tmp-";
const OLD_PREFIX = "dist.old-";

// Clean up any temp/old dirs a previous (possibly crashed) build left behind, so
// they never accumulate and never get picked up by mistake.
for (const entry of readdirSync(ROOT)) {
  if (entry.startsWith(TMP_PREFIX) || entry.startsWith(OLD_PREFIX)) {
    rmSync(join(ROOT, entry), { recursive: true, force: true });
  }
}

// Build the fresh tree in a sibling temp dir; ./dist is left untouched until the
// atomic swap at the very end.
const TMP = join(ROOT, `${TMP_PREFIX}${process.pid}`);
cpSync(SRC, TMP, { recursive: true });

// Hash the fingerprinted bundles and move them under /assets/.
mkdirSync(join(TMP, "assets"), { recursive: true });
const rewrites = {};
for (const [file, base, ext] of [
  ["styles.css", "styles", "css"],
  ["script.js", "script", "js"],
]) {
  const buf = readFileSync(join(SRC, file));
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const name = `${base}.${hash}.${ext}`;
  writeFileSync(join(TMP, "assets", name), buf);
  rmSync(join(TMP, file), { force: true }); // drop the unhashed copy from dist root
  rewrites[`/${file}`] = `/assets/${name}`;
}

// Repoint HTML references (matched with surrounding quotes so we only touch the
// href="/styles.css" / src="/script.js" attributes, never a stray substring).
// Walk the whole tree so nested pages (e.g. /evidence/*) get rewritten too, not
// just the ones at the dist root.
function rewriteHtml(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteHtml(p);
      continue;
    }
    if (!entry.name.endsWith(".html")) continue;
    let html = readFileSync(p, "utf8");
    for (const [from, to] of Object.entries(rewrites)) {
      html = html.split(`"${from}"`).join(`"${to}"`);
    }
    writeFileSync(p, html);
  }
}
rewriteHtml(TMP);

// Atomic swap: move the current ./dist aside, slot the freshly built tree in, then
// delete the old one. The only window where ./dist is absent is the gap between two
// rename syscalls (microseconds), not the whole copy/hash/rewrite pass.
if (existsSync(OUT)) {
  const OLD = join(ROOT, `${OLD_PREFIX}${process.pid}`);
  renameSync(OUT, OLD);
  renameSync(TMP, OUT);
  rmSync(OLD, { recursive: true, force: true });
} else {
  renameSync(TMP, OUT);
}

console.log(
  "build → dist:",
  Object.entries(rewrites)
    .map(([from, to]) => `${from} → ${to}`)
    .join(", ")
);
