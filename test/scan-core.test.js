/**
 * Guards that shared/scan-core.mjs stays in lockstep with the client scanner in
 * public/script.js. If these drift, a shared /s/<id> card would show a different
 * verdict than the page it links to.
 *
 * Three checks:
 *  - pool parity: the DIAGS/TEXES/RECS arrays are byte-identical in both files.
 *  - draw-order guard: finish() in public/script.js draws the seeded values in the
 *    exact order scan-core replays (reordering silently changes every verdict).
 *  - golden seeds: frozen outputs, so an accidental PRNG/algorithm change is caught.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DIAGS, TEXES, RECS, reproduce } from "../shared/scan-core.mjs";

const client = readFileSync(new URL("../public/script.js", import.meta.url), "utf8");

// Pull a `var NAME = [ ... ];` literal out of the client source and evaluate it.
function extractArray(name) {
  const m = client.match(new RegExp("var " + name + "\\s*=\\s*(\\[[\\s\\S]*?\\]);"));
  assert.ok(m, `could not find array ${name} in public/script.js`);
  return Function('"use strict"; return (' + m[1] + ");")();
}

test("DIAGS/TEXES/RECS pools match public/script.js exactly", () => {
  assert.deepEqual(DIAGS, extractArray("DIAGS"), "DIAGS drifted");
  assert.deepEqual(TEXES, extractArray("TEXES"), "TEXES drifted");
  assert.deepEqual(RECS, extractArray("RECS"), "RECS drifted");
});

test("client finish() draws seeded values in the locked order scan-core replays", () => {
  const markers = [
    "rng() < 0.02",
    "(97 + rng() * 2.9)",
    "pick(DIAGS)",
    "rand(800, 2100)",
    "pick(TEXES)",
    "pick(RECS)",
  ];
  let cursor = -1;
  for (const marker of markers) {
    const at = client.indexOf(marker, cursor + 1);
    assert.ok(at > cursor, `draw order changed: "${marker}" not found after the previous draw`);
    cursor = at;
  }
});

test("golden seeds reproduce frozen verdicts", () => {
  assert.deepEqual(reproduce("az7f2q"), {
    verdict: "FAKE", conf: "99.4", diag: "Off-the-shelf weather asset pack",
    artifacts: "1,882", tex: "VHS", rec: "Reminder: clouds are just buffering.", fakeoutRoll: false,
  });
  assert.deepEqual(reproduce("abc12"), {
    verdict: "FAKE", conf: "98.8", diag: "Lens flare, all the way down",
    artifacts: "1,986", tex: "VHS", rec: "Status: you were not supposed to see this.", fakeoutRoll: false,
  });
  assert.deepEqual(reproduce("0"), {
    verdict: "FAKE", conf: "99.8", diag: "Decommissioned planetarium",
    artifacts: "1,960", tex: "480i", rec: "Directive: question everything above eye level.", fakeoutRoll: false,
  });
});

test("reproduce is deterministic for a given seed", () => {
  assert.deepEqual(reproduce("hello"), reproduce("hello"));
});
