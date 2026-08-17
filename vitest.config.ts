import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts"],
    // gmailKeywords.test.ts predates this suite: it's a standalone fixture
    // script (run via `npx tsx`, not a real test file — no describe/it,
    // calls process.exit directly) that reimplements a simplified copy of
    // the filter logic rather than importing gmail.ts. Left untouched;
    // excluded here so it doesn't collide with vitest's discovery.
    exclude: ["**/node_modules/**", "server/gmailKeywords.test.ts"],
    environment: "node",
  },
});
