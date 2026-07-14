## Context

The `web/` stream (React 19 + Vite + TypeScript SPA) is the frontend stream, and its feature work happens in Week 2 (`docs/PLAN.md §10`). Week 1 stands up a "minimal frontend scaffold (Vite/React/routes/shell only, no features), CI green" so feature work begins against a working skeleton rather than an empty directory. This change is that scaffold.

It is unusual for OpenSpec in the opposite way that `freeze-interface-contracts` was: that change had high spec value and no runnable behavior; this change has **low spec value and runnable-but-feature-less plumbing**. There is almost nothing to *decide* behaviorally — the decisions are which conventions to apply from `docs/PLAN.md §16`, and, most importantly, **where to draw the W1/W2 line** so the scaffold installs/configures everything without accidentally building a feature that is W2 feature work. The specs therefore assert the few things that are genuinely verifiable (CI green, dev server boots, routes resolve, the shell renders, the contract type imports, smoke tests pass), and the real product of this change is a ready-to-build skeleton.

Constraints: the SPA runs inside the `vite` service of the dev Docker Compose (`bin/start`), served behind Vite's dev proxy to the `rails` service; in production Rails serves the built SPA. Conventions are inherited from `docs/PLAN.md §16` (Biome, strict TS, snake_case files, `FC<Props>`, flat `hooks`/`helpers`, nested providers, React Router 6+). The frozen `contracts-package` types exist and must be importable.

## Goals / Non-Goals

**Goals:**
- Stand up `web/` so `npm install && npm run dev` (inside the `vite` service) boots a working dev server and `npm run build` / `tsc` / Biome / Vitest all pass in CI.
- Port the team's proven frontend config (`docs/PLAN.md §16`): Biome formatter + strict rules, strict `tsconfig`, Vitest+MSW setup, error boundary, and the Vite-side `/api` + `/~cable` proxy to Rails (those two paths specifically, not a catch-all — the catch-all/SPA-fronting reverse-proxy is the `rails` side's job).
- Lay down a **static** app-shell matching the §6 workspace layout and a React Router 6+ route skeleton with placeholder pages, plus the provider-composition seam for W2.
- Prove the cross-stream seam by **importing the `contracts-package` envelope type** (compiles, not used for behavior).
- Provide a skeleton that W2 feature work can start adding to immediately.

**Non-Goals:**
- Any feature: `web/src/lib/cable.ts` (the buffer/backfill/drain reducer), the activity feed, prompt composer / follow-up / interrupt, chat, presence, the diff viewer, and the approval UI are all **Week 2 feature work**.
- **Wiring** Zustand / TanStack Query / `@rails/actioncable` to features — these libraries may be installed but must not be connected to any behavior.
- Implementing the event reducer or any contract-consuming logic beyond a type import.
- Authoring the `vite` Docker Compose service definition (that is the `dev-docker-compose` change) — this change assumes it and is structured to run inside it.
- Production serving config (Rails serving the built SPA) beyond producing a buildable artifact.

## Decisions

**1. Three thin capabilities, mapped to the three verifiable surfaces.** `web-app-shell` (project + conventions + routes + static shell + CI), `web-dev-proxy` (the Vite proxy so dev talks to Rails), `web-test-harness` (Vitest/RTL/MSW + smoke tests). *Why:* even for scaffolding, the dev proxy and the test harness are independently verifiable concerns with their own failure modes (proxy misconfigured → SPA can't reach Rails; harness misconfigured → tests can't run), and W2 references them separately (the W2 `cable.ts` relies on the `/~cable` proxy; the W2 feature tests rely on the harness). Lumping all three into one capability would make those references vaguer. Alternative (a single `web-scaffold` capability) was rejected for the same reason `freeze-interface-contracts` split four ways: downstream cites a named seam, not a section.

**2. The shell is static structure, the providers are a composition seam — and that is the W1/W2 line.** The app-shell renders the §6 layout (left sidebar / center tabs / right chat) as empty placeholder regions; `providers/app_provider.tsx` nests providers but wires **no** store/query client to data. *Why:* this is the single most important decision in a scaffolding change — it is what keeps W1 from leaking into W2. The shell and provider tree are the *shape* the W2 frontend stream fills; building any data flow into them would be designing those features ahead of that stream. The test for "did W1 stay in its lane" is: removing every W1 file under `src/` except the shell, providers, routes, error boundary, and entry leaves nothing feature-like behind.

**3. Pin Node 24 even though the host runs Node 25.** Matches `sidecar/` and the `web` CI job. *Why:* reproducibility across the three machines and CI; Node 25 is the host's incidental version, not a target. Trade-off: a one-line pin to maintain, accepted for drift-freedom.

**4. Biome only; no ESLint/Prettier.** Port `frontend/biome.json`'s formatter (2-space, double quotes, semicolons) and strict rules (`noExplicitAny`, `useImportType`, `noConsole: error`); skip the GraphQL bits and legacy ESLint remnants (`docs/PLAN.md §16`). *Why:* one tool, near-zero config debate, same as `sidecar/`. The `noConsole: error` rule is deliberate — it forces W2 logging through a real channel rather than `console.log`.

**5. Strict TS, with `forceConsistentCasingInFileNames: true`.** `strict`, `isolatedModules`, `jsx: react-jsx` ported from `frontend/tsconfig.json`; casing tightened from the team's legacy-relaxed value (`docs/PLAN.md §16`). *Why:* strict TS + the shared `contracts-package` types are what `docs/PLAN.md §13` says carries frontend correctness in lieu of exhaustive tests; consistent casing matters because filenames are snake_case and imports must match exactly.

**6. Dev proxy targets a configurable Rails host, not a hard-coded one.** The Vite-side proxy forwards `/api` and the `/~cable` (WS) path specifically — NOT a catch-all — to the `rails` compose service (e.g. `http://rails:3000`), sourced from an env var rather than a literal. The catch-all/SPA-fronting is the `rails` reverse-proxy's job (per `dev-docker-compose` + `rails-foundation`), not Vite's; this Vite-side proxy is only a convenience for running Vite directly on the host. *Why:* mirrors the "nothing assumes a fixed host" discipline that keeps Tailscale a future drop-in (the same reason the sidecar uses `SIDECAR_URL`); inside Docker the target is the service name, and a developer running Vite outside Docker needs a different target. Mount path is `/~cable` for muscle memory (`docs/PLAN.md §16`). No cable *client* is written — only the proxy that a future client will ride on.

**7. Routes resolve to placeholder pages, not redirects or guards.** React Router 6+ with at least a session-route shell and a landing/join placeholder; each route renders an empty placeholder component. *Why:* "routes resolve" is verifiable now; route guards / role-gating / join flow are behavior (and depend on auth, which is the Rails stream) — out of scope. Placeholders make the route tree real without implying features.

**8. Consume the contract by importing the envelope type only.** `web/` imports the event-envelope type from `packages/contracts` somewhere that `tsc` checks (e.g. a typed placeholder or a `helpers/` re-export), with no reducer. *Why:* this proves the cross-stream seam compiles up front (a real W2 risk is the shared package not resolving from `web/`), while explicitly not implementing the consumer. Alternative (defer all contract contact to W2) was rejected because a broken import is exactly the kind of setup failure that should be caught at scaffold time, not at the start of feature work.

**9. Two smoke tests, not a test suite.** One asserts the app-shell renders its three regions; one asserts a route resolves to its placeholder. MSW `setupServer` is configured but no handlers are needed yet. *Why:* `docs/PLAN.md §13` explicitly de-scopes exhaustive frontend tests ("strict TS + shared types carry the weight; 2-3 vitest cases") — the harness's job here is to *exist and run green*, proving `.test.tsx` files can be written immediately, not to cover behavior that doesn't exist.

**10. Tailwind v4 via `@tailwindcss/vite` (CSS-first; no PostCSS, no JS config).** Use Tailwind v4 wired through the `@tailwindcss/vite` plugin with CSS-first configuration — no PostCSS pipeline and no `tailwind.config` JS file — and pin the Tailwind major like the rest of the toolchain. *Why:* this is a greenfield repo with no legacy Tailwind config to carry forward, v4 is the current major in 2026, and the `@tailwindcss/vite` CSS-first flow avoids the deprecated v3 PostCSS plugin chain (`postcss` + `autoprefixer` + `tailwind.config.js`) entirely — fewer moving parts and one less config file to drift. *Alternative rejected:* Tailwind v3 with the PostCSS plugin — adds a PostCSS pipeline and a JS config file for no benefit on a fresh project and pins the project to the older, soon-legacy major.

## Risks / Trade-offs

- **Scope creep into W2 features.** The biggest risk in a scaffold is "just one helper" growing into a feature → mitigation: Decision 2's static-shell / seam-only line, and the proposal's explicit out-of-scope list; the requirement is that the shell carries zero data and no store/query/cable is wired.
- **`contracts-package` doesn't resolve from `web/`.** A monorepo TS path/workspace misconfig would surface as a broken import in W2 → mitigation: Decision 8 imports the envelope type in W1 so `tsc` catches it at scaffold time, not at the start of feature work.
- **Dev proxy works outside Docker but not inside (or vice-versa).** A hard-coded `localhost` target would break in the `vite` container → mitigation: Decision 6's configurable target (service name inside compose). The proxy ships in W1 but is exercised for real only when `cable.ts` lands in W2 — accepted: the config is verifiable (dev server boots, requests forward) even without a cable client.
- **`noConsole: error` annoys early debugging.** Strict-from-day-one can feel heavy on a skeleton → mitigation: it matches the team's daily config and `sidecar/`; debugging uses a real logger or test output, consistent across streams.
- **Installed-but-unwired libraries look like dead weight.** `zustand`, `@tanstack/react-query`, `react-diff-view`, etc. appear in `package.json` with no usage → mitigation: this is intentional (pre-install so W2 starts faster) and stated in the proposal; Biome/`tsc` ignore unused dependencies, so CI stays green.

## Open Questions

- **Landing/join route shape.** The exact set of placeholder routes (just `/sessions/:id`, or also a `/` landing and a `/join/:token` placeholder) depends on the final `http-api-contract` join flow; W1 only needs *enough* routes to prove resolution, and the W2 frontend stream refines the set in W2 alongside the auth flow.
