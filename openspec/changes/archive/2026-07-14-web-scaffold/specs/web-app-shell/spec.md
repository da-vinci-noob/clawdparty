## ADDED Requirements

### Requirement: Vite + React 19 + TypeScript + Tailwind project

The repository SHALL contain a `web/` package configured as a Vite + React 19 + TypeScript single-page application with **Tailwind v4** wired through the `@tailwindcss/vite` plugin (CSS-first configuration; no PostCSS pipeline and no `tailwind.config` JS file). The Tailwind major version SHALL be pinned like the rest of the toolchain (Node 24, React 19). The package SHALL pin the Node toolchain to **Node 24** (consistent with `sidecar/`), and SHALL define `dev`, `build`, `lint`, `typecheck`, and `test` scripts. `npm run build` and `tsc` SHALL succeed on the scaffold with no feature code.

#### Scenario: Dev server boots

- **WHEN** a developer runs the `dev` script in the `web/` package (inside the `vite` service)
- **THEN** the Vite dev server starts and serves the SPA without error

#### Scenario: Production build succeeds

- **WHEN** the `build` script is run on the scaffold
- **THEN** Vite produces a buildable SPA artifact and `tsc` reports no type errors

#### Scenario: Tailwind utilities are compiled into the build output

- **WHEN** the app shell uses a Tailwind utility class and the production build runs
- **THEN** the production build's emitted CSS includes the compiled utility (verified against the build output, not by visual effect in jsdom, which does not apply CSS)

### Requirement: Biome lint and format configuration

The `web/` package SHALL use **Biome** as the single lint/format tool — no ESLint and no Prettier. The configuration SHALL set the formatter to 2-space indentation, double quotes, and semicolons, and SHALL enable the strict rules `noExplicitAny`, `useImportType`, and `noConsole` at error severity, ported from the team's conventions (`docs/PLAN.md §16`).

#### Scenario: Biome passes on the scaffold

- **WHEN** the `lint` script runs Biome against the scaffold sources
- **THEN** Biome reports no errors

#### Scenario: console usage is an error

- **WHEN** scaffold code contains a `console.log` call
- **THEN** Biome reports it as an error under the `noConsole` rule

### Requirement: Strict TypeScript configuration

The `web/` package SHALL use a strict TypeScript configuration with `strict: true`, `isolatedModules: true`, `jsx: "react-jsx"`, and `forceConsistentCasingInFileNames: true` (tightened from the team's legacy-relaxed setting per `docs/PLAN.md §16`).

#### Scenario: Strict flags are enabled

- **WHEN** `tsc` type-checks the `web/` package
- **THEN** it runs under `strict`, `isolatedModules`, `jsx: react-jsx`, and `forceConsistentCasingInFileNames: true`

#### Scenario: Filename casing is enforced

- **WHEN** an import references a snake_case file with mismatched casing
- **THEN** `tsc` reports a casing error rather than silently resolving it

### Requirement: React Router route skeleton with placeholder pages

The SPA SHALL define a React Router 6+ route skeleton that includes at least a session-route shell and a landing/join placeholder. Every route SHALL resolve to an empty placeholder page. No route SHALL implement feature logic, route guards, role-gating, or a join/auth flow (those are Week 2). The `web/` `package.json` SHALL pin the React Router **major** version (e.g. a `^6` or `^7` range, not an unpinned/`*` range), so the scaffold is deterministic — React Router 6 and 7 differ materially and the major must not float.

#### Scenario: Routes resolve to placeholders

- **WHEN** the app navigates to a defined route such as the session route
- **THEN** the router renders that route's placeholder page without error

#### Scenario: No feature logic in routes

- **WHEN** the route skeleton is inspected
- **THEN** routes render placeholders only, with no data fetching, guards, or role-gating

#### Scenario: React Router major is pinned in package.json

- **WHEN** the `web/` `package.json` is inspected
- **THEN** the React Router dependency pins a single major version (e.g. `^6` or `^7`), not an unpinned range, so the scaffold resolves a deterministic React Router major

### Requirement: Static app-shell component

The SPA SHALL include a static app-shell component that renders the workspace layout from `docs/PLAN.md §6`: a left sidebar region, a center tabbed region, and a right chat-sidebar region. The shell SHALL be **placeholder structure only** — it SHALL render no data, subscribe to no events, and open no cable connection.

#### Scenario: Shell renders the three regions

- **WHEN** the app-shell component is rendered
- **THEN** it shows the left sidebar, center tabs, and right chat sidebar regions as static placeholders

#### Scenario: Shell carries no data or events

- **WHEN** the app-shell is mounted
- **THEN** it fetches no data, reads no event store, and establishes no cable connection

### Requirement: Error boundary

The SPA SHALL include an error boundary based on `react-error-boundary` (ported from `docs/PLAN.md §16`, minus Sentry wiring) that wraps the application and renders a fallback when a descendant throws during render.

#### Scenario: Fallback renders on a render error

- **WHEN** a component within the error boundary throws during render
- **THEN** the error boundary renders its fallback UI instead of crashing the app

### Requirement: Nested provider composition seam

The SPA SHALL compose its providers in a single nested `app_provider` so that Week-2 work has one place to wire feature providers. The provider composition SHALL NOT wire any Zustand store or TanStack Query client to data in this change.

#### Scenario: Providers compose without feature wiring

- **WHEN** the app mounts through the `app_provider`
- **THEN** providers are nested as the composition seam, with no store or query client wired to data

### Requirement: Frontend conventions

The `web/` package SHALL follow the team conventions from `docs/PLAN.md §16`: components written as `FC<Props>`, **snake_case filenames**, and a flat `hooks/` and `helpers/` layout.

#### Scenario: Conventions are applied

- **WHEN** scaffold source files are inspected
- **THEN** component files use snake_case names and `FC<Props>` components, and shared code lives under flat `hooks/` and `helpers/` directories

### Requirement: contracts-package resolution wiring

The `web/` package SHALL declare a dependency on `packages/contracts` via an explicit resolution mechanism — an npm/yarn workspace, a `file:` dependency, OR a TypeScript project reference / `paths` mapping — so that an import of the event-envelope type from `packages/contracts` resolves under `tsc` with no module-not-found error. This wiring SHALL exist independently of the envelope-type import, so the resolution mechanism is in place before any contract type is consumed.

#### Scenario: Contracts import resolves via the configured wiring

- **WHEN** the `web/` package imports the event-envelope type from `packages/contracts` and `tsc` type-checks it
- **THEN** `tsc` resolves the import via the configured workspace / `file:` dependency / project reference / `paths` mapping, with no module-not-found error

### Requirement: Consume the contracts-package envelope type

The `web/` package SHALL import the event-envelope type from the frozen `packages/contracts` package in a location that `tsc` type-checks, proving the cross-stream type seam resolves. It SHALL NOT implement the event reducer or any contract-consuming behavior.

#### Scenario: Envelope type imports and compiles

- **WHEN** `tsc` type-checks the `web/` package
- **THEN** the imported `packages/contracts` envelope type resolves and type-checks

#### Scenario: No reducer is implemented

- **WHEN** the scaffold is inspected
- **THEN** the contract is consumed only as a type import, with no event reducer or `cable.ts` present

### Requirement: Green web CI job

The CI pipeline SHALL include a `web` job that runs Biome, `tsc`, and Vitest on Node 24, and the job SHALL pass on the scaffold.

#### Scenario: web CI job passes

- **WHEN** the `web` CI job runs on the scaffold
- **THEN** Biome, `tsc`, and Vitest all pass and the job is green

### Requirement: Feature libraries installed but unwired

Feature libraries (`zustand`, `@tanstack/react-query`, `@rails/actioncable` with `@types/rails__actioncable`, `react-diff-view`, `react-arborist`, `shiki`, `@dnd-kit`, `anser`) MAY be installed as dependencies, but SHALL NOT be wired to any feature in this change.

#### Scenario: Libraries present without feature wiring

- **WHEN** `package.json` and the source tree are inspected
- **THEN** the libraries may appear as dependencies, but none is connected to a feature, store, query, or cable behavior
