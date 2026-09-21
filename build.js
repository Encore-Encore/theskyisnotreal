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
 *
 * Builds can also overlap each other (wrangler dev, npm test's pretest and the
 * e2e server each run this), so every build works in its own uniquely named temp
 * dir, cleans up only dirs whose build is gone, and retries the swap if another
 * build swaps at the same moment.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "public");
const OUT = join(ROOT, "dist");

const TMP_PREFIX = "dist.tmp-";
const OLD_PREFIX = "dist.old-";
// This build's temp/old dirs are named <prefix><pid>-<random>: the pid says whose
// dir it is, and the random part keeps a recycled pid from reusing a stale dir.
const RUN = `${process.pid}-${randomBytes(4).toString("hex")}`;
// A build takes well under a second, so a temp/old dir older than this is
// abandoned even if its pid has since been reused by an unrelated process.
const STALE_MS = 10 * 60 * 1000;

/** Is the process with this pid still running? Signal 0 only checks. */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // it exists, it just belongs to another user
  }
}

// Clean up temp/old dirs that a crashed build left behind, so they never
// accumulate. Dirs of a build that is still running are left alone: deleting one
// out from under a concurrent build would crash it mid-copy. Best-effort, since
// two builds may be clearing the same stale dir at once.
for (const entry of readdirSync(ROOT)) {
  const owner = entry.match(/^dist\.(?:tmp|old)-(\d+)/);
  if (!owner) continue;
  const dir = join(ROOT, entry);
  try {
    if (!isRunning(Number(owner[1])) || Date.now() - statSync(dir).mtimeMs > STALE_MS) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    /* already gone, or being removed by another build */
  }
}

// Build the fresh tree in a sibling temp dir; ./dist is left untouched until the
// atomic swap at the very end.
const TMP = join(ROOT, `${TMP_PREFIX}${RUN}`);
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
//
// Another build can swap inside that same gap. Then ./dist is already gone when we
// move it aside (fine, nothing to move), or its tree is back in place when we slot
// ours in (the rename fails on a non-empty target), so go around again after a
// short random pause. The last build to swap wins; overlapping builds of the same
// source produce the same tree.
const olds = [];
for (let attempt = 1; ; attempt++) {
  const old = join(ROOT, `${OLD_PREFIX}${RUN}-${attempt}`);
  try {
    renameSync(OUT, old);
    olds.push(old);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    renameSync(TMP, OUT);
    break;
  } catch (e) {
    const busy = e.code === "ENOTEMPTY" || e.code === "EEXIST" || e.code === "EPERM";
    if (!busy || attempt >= 10) throw e;
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
  }
}
for (const old of olds) rmSync(old, { recursive: true, force: true });

console.log(
  "build → dist:",
  Object.entries(rewrites)
    .map(([from, to]) => `${from} → ${to}`)
    .join(", ")
);
