import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Static output. The demo reads a read-only PostgREST API with the anon key, so
// there is no server-side secret and nothing to render per-request.
export default defineConfig({
  output: "static",
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
