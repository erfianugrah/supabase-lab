# governed-starter-kit - RUNLOG

## 2026-10-05 - scaffold, NOT YET RUN

Tofu (two micro projects in the Team org), kit SQL (00 baseline, 10 example
app, 20 agent schema), seed script and the K01 RLS matrix written. Nothing
applied or measured yet; no result in this file is a finding until a run line
below says so.

Same day: web app added under `app/` (Next.js + OpenNext, reused from an
earlier notes demo, switched to bun and to the publishable key, sign-up and
OAuth removed, notes replaced by purchase requests). `next build` passes with
placeholder env values; not yet run against a project.

Dependencies brought current: next 16.3.8, react / react-dom 19.3.0,
eslint-config-next 16.3.8; caret ranges already resolved to latest. Two held
back on purpose: typescript at ^6 (typescript-eslint 8.71.0 refuses TS 7, and
the `@typescript/typescript6` alias package self-resolves under bun, so it
exports nothing) and eslint at ^9 (eslint-plugin-react, pulled in by
eslint-config-next, still calls `context.getFilename`, removed in ESLint 10; its
peer range stops at ^9.7). `bun run lint`, `next build` and the OpenNext
`build:cf` all pass. `bun audit`: one high (braces <=3.0.3,
GHSA-vfj7-8cjw-p6xm) via the shadcn CLI and the Next ESLint plugin - dev
tooling only, and no patched braces is published.
