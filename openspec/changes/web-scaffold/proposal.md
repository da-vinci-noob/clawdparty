## Why

Week-2 feature work builds the live frontend (`cable.ts` reducer, activity feed, prompt composer, diff viewer, approval UI), which cannot start from an empty `web/` directory. `docs/PLAN.md §10` defines a Week-1 task — "minimal frontend scaffold: Vite + React + Biome + routes + app shell component (zero features), CI green" — whose entire purpose is a working skeleton ready before feature work begins. This change builds exactly that skeleton and **no features**: it installs and configures the toolchain, lays down the static app-shell layout and route stubs, wires the dev proxy so the SPA talks to Rails, and stands up the test harness — so W2 feature work has somewhere to land.

This is deliberately a **low-spec-value change**: it is pure scaffolding, so its verifiable surface is small (CI green, dev server boots, routes resolve, the shell renders, contract types import, smoke tests pass) rather than behavioral. The honest goal is a ready-to-build skeleton, not shipping behavior.

## What Changes

- Create `web/` as a **Vite + React 19 + TypeScript** SPA with **Tailwind**, plus the `web` CI job (Biome + `tsc` + Vitest), **pinned to Node 24** (the host runs Node 25 — pin to avoid drift; matches `sidecar/`).
- **Biome** config ported from the team's conventions (`docs/PLAN.md §16`): formatter = 2-space, double quotes, semicolons; strict rules `noExplicitAny`, `useImportType`, `noConsole: error`. Single tool — **no ESLint/Prettier**.
- **TypeScript** config: `strict`, `isolatedModules`, `jsx: react-jsx`, `forceConsistentCasingInFileNames: true` (tightened from the team's legacy-relaxed setting).
- **React Router 6+** route skeleton (e.g. a session-route shell and a landing/join placeholder). Routes **resolve to empty placeholder pages** — zero feature logic.
- A **static app-shell component** matching the `docs/PLAN.md §6` workspace layout (left sidebar / center tabs / right chat sidebar) as **placeholder structure only** — zero data, zero events, zero cable.
- An **error boundary** (`react-error-boundary`-based, minus Sentry) per `docs/PLAN.md §16`, and **nested provider composition** (`app_provider`) as the seam where W2 wires Zustand/Query providers.
- **Vite dev config**: a `/api` + `/~cable` (WebSocket) proxy to the `rails` service — specifically those two paths, NOT a catch-all (the catch-all/SPA-fronting reverse-proxy is the `rails` side's job, per `dev-docker-compose` + `rails-foundation`) — so a developer can run Vite directly on the host (`docs/PLAN.md §16`). Config present; **no cable client is implemented** (that is `web/src/lib/cable.ts`, W2).
- **Vitest + React Testing Library + MSW (`setupServer`) + jsdom** test harness with asset stubs and the co-located `.test.tsx` convention (`docs/PLAN.md §13`/§16), plus **1–2 trivial smoke tests** (the shell renders; a route resolves).
- Consume the frozen `contracts-package` types — import the **event-envelope type** to prove the seam compiles — **without** implementing the reducer.
- Conventions throughout: `FC<Props>` components, **snake_case filenames**, flat `/hooks` + `/helpers`.
- Feature libraries MAY be installed (`zustand`, `@tanstack/react-query`, `@rails/actioncable` + `@types/rails__actioncable`, `react-diff-view`, `react-arborist`, `shiki`, `@dnd-kit`, `anser`) but are **NOT wired to any feature** — installing is W1, wiring is W2.

**Explicitly out of Week-1 scope (deferred to W2 feature work):** `web/src/lib/cable.ts` (buffer/backfill/drain reducer), activity-feed real rendering, prompt composer / follow-up / interrupt buttons, chat panel, presence, diff viewer, approval UI, and Zustand-store / TanStack-Query **wiring to features**. The boundary is firm: this change **installs and configures**; behavior arrives in W2.

## Capabilities

### New Capabilities
- `web-app-shell`: The Vite + React 19 + TypeScript + Tailwind project, Biome + strict `tsconfig`, the React Router 6+ route skeleton (placeholder pages), the static app-shell layout (left/center/right per §6), the `react-error-boundary` error boundary, nested provider composition, the snake_case / `FC<Props>` / flat `hooks`+`helpers` conventions, consumption of the `contracts-package` envelope type, and a green `web` CI job (Biome + `tsc` + Vitest, Node 24).
- `web-dev-proxy`: The Vite dev-server proxy configuration — the `/api` proxy and the `/~cable` WebSocket proxy to the `rails` service (those two paths specifically, NOT a catch-all; the catch-all/SPA-fronting is the `rails` reverse-proxy's job per `dev-docker-compose` + `rails-foundation`) — so a developer can run Vite directly on the host and reach Rails, with no cable client implemented yet (`SIDECAR_URL`-style no-hard-coded-host discipline applied to the proxy target).
- `web-test-harness`: The Vitest + React Testing Library + MSW (`setupServer`) + jsdom setup, asset stubs, the co-located `.test.tsx` convention, and 1–2 trivial smoke tests that prove the harness and the shell render.

### Modified Capabilities
<!-- None — this is a greenfield repo with no existing specs. This change CONSUMES the frozen contracts-package, event-envelope, and http-api-contract capabilities (from freeze-interface-contracts) without modifying them. -->

## Impact

- **New files:** `web/` package (`package.json`, `vite.config.ts`, `tsconfig.json`, Biome config, `vitest.config.ts`, `index.html`, Tailwind v4 entry CSS via `@tailwindcss/vite` — no `tailwind.config` JS file), `web/src/` entry + `app.tsx` + `providers/app_provider.tsx` + `components/app_shell.tsx` + `components/error_boundary.tsx` + placeholder route pages + flat `hooks/` + `helpers/`, `web/test/vitest.setup.ts` + asset stubs, co-located `*.test.tsx` smoke tests; the GitHub Actions `web` CI job (Node 24).
- **Consumes (does not modify):** `contracts-package` (the shared TS types — importing the envelope type proves the seam compiles), and references `http-api-contract` (the `/~cable` mount + REST surface the dev proxy targets) — both frozen by `freeze-interface-contracts`.
- **Cross-stream dependency:** the Week-2 frontend stream (`docs/PLAN.md §10`) — `cable.ts`, activity feed, composer, chat/presence, diff viewer, approval UI — all build on this skeleton. Runs inside the `vite` service of the dev Docker Compose (`bin/start`); the actual `vite` service wiring lands in the `dev-docker-compose` change.
- **No feature behavior yet** — routes resolve to placeholders, the shell is static, no cable/stores/queries are wired; live behavior is Week 2.

## Dependencies

- **`freeze-interface-contracts` (prerequisite — apply first).** `web/` imports the event-envelope type from `packages/contracts`, and the contract type seam (the `contracts-package` resolution wiring + envelope-type import) must resolve under `tsc`. The frozen `packages/contracts` package must therefore exist before this change. **Apply ordering: `freeze-interface-contracts` before `web-scaffold`.**
- **`dev-docker-compose` (runtime / topology dependency).** This scaffold runs inside the `vite` service of the dev Docker Compose, served behind the `rails` reverse-proxy that fronts the dev SPA + HMR on the single published port (`3000`). The `vite` service definition, the `rails` reverse-proxy, and the `VITE_USE_POLLING` env var on the `vite` service are owned by `dev-docker-compose`; `web-scaffold` only configures the Vite side to ride on them.
- **`rails-foundation` (runtime dependency).** Implements the `rails` reverse-proxy that fronts the dev SPA, its assets, and the Vite HMR WebSocket. The dev proxy/HMR behavior in `web-dev-proxy` is verified for real only once `rails-foundation`'s reverse-proxy is up.
