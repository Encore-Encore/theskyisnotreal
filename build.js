/**
 * Build step: copy ./public -> ./dist, then content-hash the CSS/JS bundles
 * into /assets/ and rewrite every HTML reference to point at the hashed name.
 *
 * Because a hashed filename changes whenever its contents change, the Worker can
 * serve /assets/* with `Cache-Control: immutable` (see src/index.js) without ever
 * risking a stale bundle after a deploy. Everything else in ./public is copied
 * through untouched. Wrangler runs this automatically before `dev` and `deploy`
 * via the `build.command` hook in wrangler.jsonc.
 */
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "public");
const OUT = join(ROOT, "dist");

// Fresh output tree every build.
rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

// Hash the fingerprinted bundles and move them under /assets/.
mkdirSync(join(OUT, "assets"), { recursive: true });
const rewrites = {};
for (const [file, base, ext] of [
  ["styles.css", "styles", "css"],
  ["script.js", "script", "js"],
]) {
  const buf = readFileSync(join(SRC, file));
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const name = `${base}.${hash}.${ext}`;
  writeFileSync(join(OUT, "assets", name), buf);
  rmSync(join(OUT, file), { force: true }); // drop the unhashed copy from dist root
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
rewriteHtml(OUT);

console.log(
  "build → dist:",
  Object.entries(rewrites)
    .map(([from, to]) => `${from} → ${to}`)
    .join(", ")
);
