import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { client: "src/client.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    splitting: false,
    external: ["ws"]
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
    external: ["ws"]
  }
]);
