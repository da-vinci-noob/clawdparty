import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearerToken, tokenMatches } from "../../src/auth.js";
import { buildServer } from "../../src/index.js";
import { Supervisor } from "../../src/supervisor.js";
import { Transport } from "../../src/transport.js";

/**
 * every harness control route authenticates inbound requests, and network
 * placement is NOT the access control.
 *
 * This is the assertion the host move makes necessary. As a compose service the
 * harness sat on a private network no other process could address, so an
 * unauthenticated route was reachable only by its siblings. On the host it listens on
 * loopback, which every process running as the developer can reach — a browser tab
 * on a malicious page cannot send the bearer, but it CAN send a request.
 */

const SECRET = "test-shared-secret-not-a-real-one";
const CONFIG = { sharedSecret: SECRET };

let dir: string;
let supervisor: Supervisor;

function silentTransport(): Transport {
  return new Transport({
    railsInternalUrl: "http://rails:3000",
    sharedSecret: "s",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
}

/**
 * Every route the harness exposes, so a new one cannot be added unauthenticated.
 *
 * `covers every route Fastify registered` below checks this list against the server's own
 * routing table. Without that check the comment is a wish: the list is hand-maintained,
 * and a route added without a line here would be tested by nothing while the file still
 * claimed to cover everything.
 */
const ROUTES: Array<{ method: "GET" | "POST"; url: string; pattern: string }> = [
  { method: "GET", url: "/healthz", pattern: "/healthz" },
  { method: "GET", url: "/runs", pattern: "/runs" },
  { method: "GET", url: "/models", pattern: "/models" },
  { method: "GET", url: "/connectors", pattern: "/connectors" },
  { method: "GET", url: "/skills", pattern: "/skills" },
  { method: "GET", url: "/aws-profiles", pattern: "/aws-profiles" },
  { method: "GET", url: "/sessions/45/entries", pattern: "/sessions/:id/entries" },
  { method: "POST", url: "/verify", pattern: "/verify" },
  { method: "POST", url: "/skills", pattern: "/skills" },
  { method: "POST", url: "/skills/remove", pattern: "/skills/remove" },
  { method: "POST", url: "/runs", pattern: "/runs" },
  { method: "POST", url: "/runs/1/messages", pattern: "/runs/:id/messages" },
  { method: "POST", url: "/runs/1/interrupt", pattern: "/runs/:id/interrupt" },
];

/**
 * Parse `printRoutes` into full method+path pairs.
 *
 * The tree NESTS on shared prefixes even with `commonPrefix: false`, so
 * `/runs/:id/messages` renders as a child line `/:id/messages` under a `/runs` parent
 * and a naive per-line regex yields the fragment. Depth comes from the 4-character
 * indent units, and each depth's prefix is remembered so a child can be joined to it.
 *
 * HEAD is dropped: Fastify adds it automatically alongside every GET, through the same
 * onRequest hook.
 */
function registeredRoutes(tree: string): Array<{ method: string; pattern: string }> {
  const out: Array<{ method: string; pattern: string }> = [];
  const prefixAtDepth: string[] = [];

  for (const line of tree.split("\n")) {
    const match = /^((?:(?:│|\s)\s{3})*)(?:├──|└──) (\S*) \(([A-Z, ]+)\)/.exec(line);
    if (!match) continue;

    const depth = (match[1] as string).length / 4;
    const full = (depth === 0 ? "" : (prefixAtDepth[depth - 1] ?? "")) + (match[2] as string);
    prefixAtDepth[depth] = full;

    for (const method of (match[3] as string).split(", ")) {
      if (method !== "HEAD") out.push({ method, pattern: full });
    }
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-auth-"));
  supervisor = new Supervisor(silentTransport(), { storeDir: dir });
});
afterEach(async () => {
  await supervisor.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe("every control route rejects a bad token", () => {
  const rejected: Array<[string, Record<string, string>]> = [
    ["absent", {}],
    ["empty bearer", { authorization: "Bearer " }],
    ["empty header", { authorization: "" }],
    ["wrong token", { authorization: "Bearer wrong-token" }],
    ["right token, wrong scheme", { authorization: `Basic ${SECRET}` }],
    ["token without the scheme", { authorization: SECRET }],
    // A prefix of the real secret must fail: a comparison that stopped at the
    // shorter length would accept it.
    ["a prefix of the secret", { authorization: `Bearer ${SECRET.slice(0, 10)}` }],
    // ...and so must the secret plus trailing content.
    ["the secret with a suffix", { authorization: `Bearer ${SECRET}x` }],
  ];

  for (const [name, headers] of rejected) {
    it(`rejects ${name} on all ${ROUTES.length} routes`, async () => {
      const app = buildServer(supervisor, CONFIG);

      for (const { method, url } of ROUTES) {
        const res = await app.inject({ method, url, headers, payload: {} });
        expect(res.statusCode, `${method} ${url} accepted a ${name} token`).toBe(401);
      }

      await app.close();
    });
  }

  it("covers every route Fastify registered, so the list cannot fall behind", async () => {
    const app = buildServer(supervisor, CONFIG);
    await app.ready();

    const registered = registeredRoutes(app.printRoutes({ commonPrefix: false }));
    const listed = new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`));
    const missing = registered
      .map((r) => `${r.method} ${r.pattern}`)
      .filter((key) => !listed.has(key));

    // Read from the server's own routing table rather than restated. A route added
    // without a line above would otherwise be covered by nothing while this file still
    // claimed to cover everything — which is worse than having no list.
    expect(missing).toEqual([]);
    // Guards the guard: a parser that matched nothing would make `missing` empty and the
    // assertion above vacuously true.
    expect(registered.length).toBe(ROUTES.length);
    await app.close();
  });

  it("parses a NESTED route tree, which is what makes the check above real", () => {
    // The shape Fastify actually emits: `/runs/:id/messages` appears as a child fragment
    // under a `/runs` parent, so a per-line regex returns `/:id/messages` and the coverage
    // check silently compares the wrong strings.
    const tree = [
      "├── /healthz (GET, HEAD)",
      "├── /runs (GET, HEAD, POST)",
      "│   ├── /:id/messages (POST)",
      "│   └── /:id/interrupt (POST)",
      "└── /sessions/:id/entries (GET, HEAD)",
      "",
    ].join("\n");

    expect(registeredRoutes(tree)).toEqual([
      { method: "GET", pattern: "/healthz" },
      { method: "GET", pattern: "/runs" },
      { method: "POST", pattern: "/runs" },
      { method: "POST", pattern: "/runs/:id/messages" },
      { method: "POST", pattern: "/runs/:id/interrupt" },
      { method: "GET", pattern: "/sessions/:id/entries" },
    ]);
  });

  it("says only 'unauthorized', never which part was wrong", async () => {
    const app = buildServer(supervisor, CONFIG);

    const absent = await app.inject({ method: "GET", url: "/healthz" });
    const wrong = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { authorization: "Bearer nope" },
    });

    // Identical bodies: distinguishing "no token" from "wrong token" tells a caller
    // whether it guessed the scheme right, which is a probing aid and buys nothing.
    expect(absent.json()).toEqual({ error: "unauthorized" });
    expect(wrong.json()).toEqual(absent.json());

    await app.close();
  });
});

describe("the valid token is accepted", () => {
  it("passes the correct bearer through to the route", async () => {
    const app = buildServer(supervisor, CONFIG);

    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { authorization: `Bearer ${SECRET}` },
    });

    // Without this the suite above would pass with a hook that refuses everything.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active_run_ids: [] });

    await app.close();
  });
});

describe("/healthz has an EXPLICIT policy: it authenticates too", () => {
  it("does not exempt the liveness probe", async () => {
    const app = buildServer(supervisor, CONFIG);
    const res = await app.inject({ method: "GET", url: "/healthz" });

    // Deliberate, and the reason is that nothing needs an exemption: launchd/systemd
    // supervise the PROCESS rather than polling HTTP, and `bin/harness status` reads
    // the same .env.local the secret is generated into. Exempting it would publish
    // active_run_ids to every local process for no consumer's benefit.
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("an unset secret cannot authenticate anything", () => {
  it("refuses every request when the configured secret is empty", async () => {
    const app = buildServer(supervisor, { sharedSecret: "" });

    // THE trap, and the same shape as an empty ANTHROPIC_API_KEY winning its
    // precedence slot: without the guard in tokenMatches, an empty expected secret
    // would match an empty presented one and open the whole surface. index.ts also
    // refuses to BOOT in this state; this is the fail-closed half.
    for (const headers of [{}, { authorization: "Bearer " }, { authorization: "Bearer x" }]) {
      const res = await app.inject({ method: "GET", url: "/healthz", headers });
      expect(res.statusCode).toBe(401);
    }

    await app.close();
  });
});

describe("the comparison primitives", () => {
  it("never treats an empty expected secret as a match", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("anything", "")).toBe(false);
  });

  it("matches only an exact token", () => {
    expect(tokenMatches(SECRET, SECRET)).toBe(true);
    expect(tokenMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(tokenMatches(`${SECRET} `, SECRET)).toBe(false);
  });

  it("compares unequal lengths without throwing", () => {
    // timingSafeEqual raises RangeError on Buffers of differing byte length. Hashing
    // first makes both operands 32 bytes, so a short token is REJECTED rather than
    // turning into a 500 where a 401 belongs.
    expect(() => tokenMatches("short", "a-much-longer-secret-value")).not.toThrow();
    expect(tokenMatches("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("compares in constant time, asserted at the source", () => {
    // Constant-time-ness is not observable through the function's return value, and a
    // timing measurement would be flaky. So this is a SOURCE assertion, same genre as
    // no_shell_input.test.ts. It exists because `presented === expected` passes every
    // behavioural test in this file — it is correct about equality and wrong about
    // leaking, which is exactly the mutation nothing else here catches.
    const body = readFileSync(new URL("../../src/auth.ts", import.meta.url), "utf8");

    expect(body).toMatch(/timingSafeEqual\(/);
    expect(body, "auth.ts must not compare tokens with === or ==").not.toMatch(
      /presented\s*={2,3}\s*expected|expected\s*={2,3}\s*presented/,
    );
    // Digest-then-compare is what keeps timingSafeEqual from throwing AND stops the
    // length itself leaking through a pre-check.
    expect(body).toMatch(/createHash\("sha256"\)/);
  });

  it("parses only the Bearer scheme", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});
