import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// The same app the corpus-graph demo is: static output, one React island,
// Tailwind, a self-hosted font. SITE_BASE is the path prefix the host mounts
// the site under - "/" on Pages/Netlify, but Storage serves a bucket under
// /storage/v1/object/public/<bucket> and a function under /functions/v1/<slug>,
// so the same source has to be built once per host. OUT_DIR keeps the builds apart.
export default defineConfig({
  output: "static",
  base: process.env.SITE_BASE ?? "/",
  outDir: process.env.OUT_DIR ?? "./dist",
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
