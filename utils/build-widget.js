// Bundles src/widget into dist/assets/v1/bugzap.js, which wrangler serves as a static asset.
// Runs as wrangler's build.command, so `wrangler dev` rebuilds it on every save under src/widget.

import { build } from "esbuild";

const started = Date.now();
await build({
  entryPoints: ["src/widget/index.ts"],
  outfile: "dist/assets/v1/bugzap.js",
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});
console.log(`[build-widget] dist/assets/v1/bugzap.js in ${Date.now() - started}ms`);
