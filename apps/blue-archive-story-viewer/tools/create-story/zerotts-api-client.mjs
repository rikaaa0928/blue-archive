const defaultRateLimitRetries = 12;
const defaultRateLimitBackoffMs = 5_000;
const defaultRateLimitMaxBackoffMs = 60_000;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function retryAfterMilliseconds(response, attempt, {
  baseDelayMs = defaultRateLimitBackoffMs,
  maxDelayMs = defaultRateLimitMaxBackoffMs,
  now = Date.now(),
} = {}) {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1000), maxDelayMs);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(0, retryAt - now), maxDelayMs);
    }
  }
  return Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
}

export async function requestZeroTts({
  baseUrl,
  token,
  endpoint,
  options = {},
  rateLimitRetries = defaultRateLimitRetries,
  rateLimitBackoffMs = defaultRateLimitBackoffMs,
  rateLimitMaxBackoffMs = defaultRateLimitMaxBackoffMs,
  fetchImpl = fetch,
  sleepImpl = sleep,
  logger = console,
}) {
  const url = `${baseUrl.replace(/\/+$/, "")}${endpoint}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        "X-API-Key": token,
        ...(options.headers || {}),
      },
    });

    if (response.status === 429) {
      const detail = await response.text();
      if (attempt >= rateLimitRetries) {
        throw new Error(`ZeroTTS HTTP 429 after ${attempt + 1} attempts: ${detail}`);
      }
      const delayMs = retryAfterMilliseconds(response, attempt, {
        baseDelayMs: rateLimitBackoffMs,
        maxDelayMs: rateLimitMaxBackoffMs,
      });
      logger.warn(
        `ZeroTTS queue is full (HTTP 429). Retrying in ` +
          `${Math.ceil(delayMs / 1000)}s (${attempt + 1}/${rateLimitRetries})`,
      );
      await sleepImpl(delayMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(`ZeroTTS HTTP ${response.status}: ${await response.text()}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return response;
    }

    const payload = await response.json();
    if (payload?.code && payload.code !== 200) {
      throw new Error(payload.message || `ZeroTTS API error code ${payload.code}`);
    }
    return payload.data ?? payload;
  }
}
