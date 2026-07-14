import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local runs only. `wrangler dev` creates an empty local D1, so apply schema.sql
// (otherwise the signup INSERT hits a missing table) and seed one located scan so
// the /s/<id> geo test has data. Best-effort: failures surface in the tests rather
// than hang.
export default async function globalSetup() {
  const run = (args) =>
    execSync(`npx wrangler d1 execute theskyisnotreal-db --local ${args} -y`, {
      stdio: "ignore",
    });
  try {
    run("--file=schema.sql");
    const seedSql = join(tmpdir(), "e2e-scan-seed.sql");
    writeFileSync(
      seedSql,
      "INSERT INTO scans (country, region, city, seed, latitude, longitude) VALUES ('GB','England','London','e2elon',51.5074,-0.1278);"
    );
    run(`--file=${seedSql}`);
  } catch (err) {
    console.warn("[e2e] local D1 setup failed:", err.message);
  }
}
