## 1. Project scaffold (web-app-shell)

- [x] 1.1 Create the `web/` package: `package.json` with `dev`/`build`/`lint`/`typecheck`/`test` scripts, Node 24 pin (`engines` + `.nvmrc`/Volta), React 19 + Vite + TypeScript deps
- [x] 1.2 Add `index.html` + `web/src/main.tsx` entry mounting React 19
- [x] 1.3 Add Tailwind **v4** via the `@tailwindcss/vite` plugin (CSS-first config, no PostCSS pipeline, no `tailwind.config` JS file); pin the Tailwind major version; add an entry CSS imported by the app
- [x] 1.4 Add `tsconfig.json`: `strict`, `isolatedModules`, `jsx: react-jsx`, `forceConsistentCasingInFileNames: true`
- [x] 1.5 Wire `packages/contracts` resolution: declare the dependency from `web/` via the chosen mechanism (npm/yarn workspace OR a `file:` dependency OR a TS project reference / `paths` mapping) so the envelope-type import resolves under `tsc`
- [x] 1.6 Verify `npm run dev` boots the Vite server and `npm run build` + `tsc` succeed on the empty scaffold

## 2. Tooling config (web-app-shell)

- [x] 2.1 Add `biome.json` ported from the team config: formatter 2-space / double quotes / semicolons; rules `noExplicitAny`, `useImportType`, `noConsole: error`; no ESLint/Prettier
- [x] 2.2 Confirm Biome lint passes and that a `console.log` is flagged as an error

## 3. App shell, routes, providers, error boundary (web-app-shell)

- [x] 3.1 Add the React Router 6+ route skeleton: at least a session-route shell and a landing/join placeholder, each rendering an empty placeholder page (no guards, no role-gating, no join flow); pin the React Router **major** version in `package.json` (e.g. `^6` or `^7`, not an unpinned range — RR6 vs RR7 differ materially) so the scaffold is deterministic
- [x] 3.2 Implement `web/src/components/app_shell.tsx` — static left sidebar / center tabs / right chat-sidebar regions per `docs/PLAN.md §6`; zero data, zero events, no cable
- [x] 3.3 Implement `web/src/components/error_boundary.tsx` (`react-error-boundary`-based, no Sentry) wrapping the app with a fallback
- [x] 3.4 Implement `web/src/providers/app_provider.tsx` — nested provider composition seam; wire NO Zustand store / TanStack Query client to data
- [x] 3.5 Apply conventions throughout: `FC<Props>` components, snake_case filenames, flat `hooks/` + `helpers/`

## 4. Contract type seam (web-app-shell)

- [x] 4.1 Import the event-envelope type from `packages/contracts` in a `tsc`-checked location (e.g. a typed placeholder or a `helpers/` re-export); implement NO reducer or `cable.ts` (depends on the `packages/contracts` resolution wiring from task 1.5)
- [x] 4.2 Confirm `tsc` resolves and type-checks the `packages/contracts` import from `web/`

## 5. Feature libraries — install only (web-app-shell)

- [x] 5.1 Install (do not wire) `zustand`, `@tanstack/react-query`, `@rails/actioncable` + `@types/rails__actioncable`, `react-diff-view`, `react-arborist`, `shiki`, `@dnd-kit`, `anser`
- [x] 5.2 Confirm Biome + `tsc` stay green with the unwired dependencies present

## 6. Dev proxy (web-dev-proxy)

- [x] 6.1 Set `server.host: true` so the `rails` reverse-proxy can reach the unpublished `vite` service over the compose network (LAN/browser entry point is the `rails` port `3000`, not `5173`)
- [x] 6.2 Set `server.hmr.clientPort: 3000` so the HMR WebSocket points at the `rails` published port the browser connects to and survives the `rails`→`vite` proxy hop
- [x] 6.3 Enable `server.watch.usePolling` gated on the `VITE_USE_POLLING` env var (the `dev-docker-compose` change sets it on the `vite` service; on by default in the container) so macOS host bind-mount edits propagate into the Linux container and trigger HMR
- [x] 6.4 Add the Vite proxy of `/api` to the `rails` service, with the target sourced from configuration (env var / service name), not a hard-coded `localhost` (convenience for running Vite directly on the host outside the compose stack; in the normal Docker flow the browser reaches everything through the `rails` reverse-proxy)
- [x] 6.5 Add the `/~cable` WebSocket-upgrade proxy to the Rails target (mount path `/~cable`); implement NO cable client
- [x] 6.6 Verify the dev server boots with the config above and is configured to forward `/api` (and `/~cable` WS) to the Rails target (real forwarding + HMR-through-rails verified once `dev-docker-compose` + Rails are up)

## 7. Test harness (web-test-harness)

- [x] 7.1 Add `vitest.config.ts` (jsdom env) + `web/test/vitest.setup.ts` with React Testing Library, asset stubs, and an MSW `setupServer` instance
- [x] 7.2 Establish the co-located `.test.tsx` convention
- [x] 7.3 Write a smoke test asserting `app_shell` renders its three regions
- [x] 7.4 Write a smoke test asserting a defined route resolves to its placeholder page
- [x] 7.5 Confirm `npm run test` (Vitest) passes green

## 8. CI and handoff

- [x] 8.1 Add the GitHub Actions `web` job: Biome + `tsc` + Vitest on Node 24
- [x] 8.2 Confirm the `web` CI job is green on the scaffold
- [x] 8.3 Verify the W1/W2 line holds: shell is static, no store/query/cable wired, routes are placeholders — `bin/start` boots the skeleton and W2 feature work can begin immediately
