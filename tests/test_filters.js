import { test } from "node:test";
import assert from "node:assert/strict";
import { rugScan, quantumScore } from "../src/sniperEngine.js";

function fakePair(overrides = {}) {
  return {
    baseToken: { symbol: "TESTCOIN", address: "TestAddr111" },
    priceUsd: "0.001",
    liquidity: { usd: 50000 },
    marketCap: 200000,
    volume: { h1: 20000, m5: 5000 },
    priceChange: { m5: "10", h1: "25" },
    txns: { m5: { buys: 30, sells: 10 } },
    pairCreatedAt: Date.now() - 3 * 60_000, // 3 minutes old
    ...overrides,
  };
}

test("rugScan flags blocklisted symbols", () => {
  const result = rugScan(fakePair({ baseToken: { symbol: "PEPE", address: "x" } }));
  assert.equal(result.safe, false);
  assert.ok(result.flags.includes("BLOCKLISTED"));
});

test("rugScan flags liquidity below the sweet-spot floor", () => {
  const result = rugScan(fakePair({ liquidity: { usd: 500 } }));
  assert.equal(result.safe, false);
  assert.ok(result.flags.includes("LOW_LIQ"));
});

test("rugScan flags liquidity above the sweet-spot ceiling", () => {
  const result = rugScan(fakePair({ liquidity: { usd: 500000 } }));
  assert.equal(result.safe, false);
  assert.ok(result.flags.includes("LIQ_TOO_HIGH"));
});

test("rugScan passes a healthy fresh token", () => {
  const result = rugScan(fakePair());
  assert.equal(result.safe, true);
  assert.deepEqual(result.flags, []);
});

test("rugScan skipAgeCheck ignores freshness for open positions", () => {
  const oldPair = fakePair({ pairCreatedAt: Date.now() - 60 * 60_000 }); // 1hr old
  const result = rugScan(oldPair, { skipAgeCheck: true });
  assert.equal(result.safe, true);
});

test("rugScan waives freshness for vetted tokens with strong momentum", () => {
  const oldPair = fakePair({ pairCreatedAt: Date.now() - 60 * 60_000, priceChange: { m5: "20", h1: "25" } });
  const result = rugScan(oldPair, { vetted: true });
  assert.equal(result.safe, true);
});

test("quantumScore returns 0 for an unsafe token", () => {
  const score = quantumScore(fakePair({ baseToken: { symbol: "MEW", address: "x" } }));
  assert.equal(score, 0);
});

test("quantumScore returns a value between 0 and 1 for a healthy token", () => {
  const score = quantumScore(fakePair());
  assert.ok(score >= 0 && score <= 1);
});
