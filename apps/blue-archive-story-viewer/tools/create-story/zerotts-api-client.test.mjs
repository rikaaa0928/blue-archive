import assert from "node:assert/strict";
import test from "node:test";

import {
  requestZeroTts,
  retryAfterMilliseconds,
} from "./zerotts-api-client.mjs";

function response(status, body, headers = {}) {
  return new Response(body, { status, headers });
}

test("uses Retry-After before exponential backoff", () => {
  assert.equal(
    retryAfterMilliseconds(response(429, "", { "Retry-After": "12" }), 3),
    12_000,
  );
  assert.equal(retryAfterMilliseconds(response(429, ""), 0), 5_000);
  assert.equal(retryAfterMilliseconds(response(429, ""), 5), 60_000);
});

test("retries confirmed HTTP 429 responses and returns the successful payload", async () => {
  const statuses = [429, 429, 200];
  const delays = [];
  const result = await requestZeroTts({
    baseUrl: "https://example.invalid/api/tts",
    token: "secret",
    endpoint: "/tasks",
    options: { method: "POST", body: "{}" },
    fetchImpl: async () => {
      const status = statuses.shift();
      return status === 200
        ? response(200, JSON.stringify({ code: 200, data: { taskId: "task-1" } }), {
          "Content-Type": "application/json",
        })
        : response(429, "queue full");
    },
    sleepImpl: async delay => delays.push(delay),
    logger: { warn() {} },
  });
  assert.deepEqual(delays, [5_000, 10_000]);
  assert.deepEqual(result, { taskId: "task-1" });
});

test("stops after the configured number of HTTP 429 retries", async () => {
  let requests = 0;
  await assert.rejects(
    requestZeroTts({
      baseUrl: "https://example.invalid/api/tts",
      token: "secret",
      endpoint: "/tasks",
      rateLimitRetries: 2,
      fetchImpl: async () => {
        requests += 1;
        return response(429, "queue full");
      },
      sleepImpl: async () => {},
      logger: { warn() {} },
    }),
    /HTTP 429 after 3 attempts/u,
  );
  assert.equal(requests, 3);
});

test("does not retry non-429 errors", async () => {
  let requests = 0;
  await assert.rejects(
    requestZeroTts({
      baseUrl: "https://example.invalid/api/tts",
      token: "secret",
      endpoint: "/tasks",
      fetchImpl: async () => {
        requests += 1;
        return response(500, "server error");
      },
      sleepImpl: async () => {},
      logger: { warn() {} },
    }),
    /HTTP 500/u,
  );
  assert.equal(requests, 1);
});
