import { execSync } from "node:child_process";

// Local runs only. `wrangler dev` creates an empty local D1, so apply schema.sql
// once up front, otherwise the signup story's INSERT hits a missing table (500).
// Best-effort: if it fails, the signup test will surface it rather than hang.
export default async function globalSetup() {
  try {
    execSync(
      "npx wrangler d1 execute theskyisnotreal-db --local --file=schema.sql -y",
      { stdio: "ignore" }
    );
  } catch (err) {
    console.warn("[e2e] local D1 schema apply failed:", err.message);
  }
}
