import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Phase 5.1A: mirrors vite.config.ts's own "@shared" alias — needed so a
  // test can import a module that pulls in @shared/schema for real (e.g.
  // server/storage.ts's actual table objects), rather than only ever
  // reaching schema.ts through erased `import type` (every pre-existing
  // test file's approach, which never needed this alias). No production
  // config touched; this file only affects module resolution inside the
  // test runner.
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
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
