import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/worker/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            DEV_ROUTER_SECRET: "test-secret",
            DEV_ROUTER_DASHBOARD_PASSWORD: "test-dashboard-password"
          }
        }
      }
    }
  }
});
