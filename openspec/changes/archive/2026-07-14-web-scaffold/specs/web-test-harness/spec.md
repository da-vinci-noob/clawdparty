## ADDED Requirements

### Requirement: Vitest + React Testing Library + jsdom setup

The `web/` package SHALL configure a Vitest test harness with React Testing Library running under a jsdom environment, ported from the team's conventions (`docs/PLAN.md §13`/§16). The setup SHALL stub static assets so component imports do not break tests, and tests SHALL run green via the package `test` script.

#### Scenario: Test harness runs green

- **WHEN** the `test` script runs Vitest on the scaffold
- **THEN** the configured tests pass under jsdom with React Testing Library

#### Scenario: Asset imports do not break tests

- **WHEN** a component under test imports a static asset (such as an image or CSS)
- **THEN** the asset is stubbed by the test setup and the test runs without an import error

### Requirement: MSW REST mocking via setupServer

The test harness SHALL configure Mock Service Worker (MSW) using `setupServer` for REST mocking, established as the convention so Week-2 feature tests can register handlers. No request handlers are required in this change.

#### Scenario: MSW server is configured

- **WHEN** the test setup runs
- **THEN** an MSW `setupServer` instance is started for the test run, ready for handlers to be added later

### Requirement: Co-located test convention

Tests SHALL follow the team convention of co-located `.test.tsx` files placed alongside the components they test (`docs/PLAN.md §13`/§16).

#### Scenario: Tests are co-located

- **WHEN** the test files are inspected
- **THEN** each `.test.tsx` file sits next to the component it tests

### Requirement: Smoke tests prove the harness and shell

The change SHALL include one to two trivial smoke tests that prove the harness works and the scaffold renders: at least one asserting the static app-shell renders its three regions, and at least one asserting a route resolves to its placeholder page.

#### Scenario: App-shell smoke test passes

- **WHEN** the app-shell smoke test runs
- **THEN** it asserts the left sidebar, center tabs, and right chat regions render, and passes

#### Scenario: Route smoke test passes

- **WHEN** the route smoke test runs
- **THEN** it navigates to a defined route, asserts the placeholder page renders, and passes
