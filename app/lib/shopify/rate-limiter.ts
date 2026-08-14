import redis from "../queue/connection";

// Shopify's GraphQL Admin API uses cost-based throttling: every response
// carries `extensions.cost.throttleStatus` with the bucket's current state.
// We cache the last known state per shop in Redis (shared across worker
// processes/replicas) and use it to (a) proactively wait for budget before
// firing a request and (b) back off precisely when THROTTLED is returned,
// instead of guessing with blind exponential backoff.

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
  updatedAtMs: number;
}

// Shopify's default bucket for standard/advanced plans before we've seen a
// real response; conservative enough to avoid a thundering-herd first call.
const DEFAULT_STATUS: ThrottleStatus = {
  maximumAvailable: 1000,
  currentlyAvailable: 1000,
  restoreRate: 50,
  updatedAtMs: Date.now(),
};

const CACHE_TTL_SECONDS = 300;

function cacheKey(shopDomain: string): string {
  return `duplify:throttle:${shopDomain}`;
}

async function getStatus(shopDomain: string): Promise<ThrottleStatus> {
  const raw = await redis.get(cacheKey(shopDomain));
  if (!raw) return DEFAULT_STATUS;
  try {
    return JSON.parse(raw) as ThrottleStatus;
  } catch {
    return DEFAULT_STATUS;
  }
}

function estimateAvailable(status: ThrottleStatus): number {
  const elapsedSeconds = Math.max(0, (Date.now() - status.updatedAtMs) / 1000);
  return Math.min(
    status.maximumAvailable,
    status.currentlyAvailable + elapsedSeconds * status.restoreRate,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call before firing a GraphQL request. Blocks (in small increments) until the
// bucket is estimated to have enough points, capped so a stuck estimate can
// never stall a job forever.
export async function waitForBudget(
  shopDomain: string,
  estimatedCost = 50,
): Promise<void> {
  const status = await getStatus(shopDomain);
  const available = estimateAvailable(status);
  if (available >= estimatedCost) return;

  const deficit = estimatedCost - available;
  const waitMs = Math.ceil((deficit / status.restoreRate) * 1000);
  await sleep(Math.min(Math.max(waitMs, 0), 10_000));
}

interface CostExtension {
  throttleStatus?: {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  };
}

export async function recordThrottleStatus(
  shopDomain: string,
  cost: CostExtension | undefined,
): Promise<void> {
  if (!cost?.throttleStatus) return;
  const status: ThrottleStatus = {
    maximumAvailable: cost.throttleStatus.maximumAvailable,
    currentlyAvailable: cost.throttleStatus.currentlyAvailable,
    restoreRate: cost.throttleStatus.restoreRate,
    updatedAtMs: Date.now(),
  };
  await redis.set(
    cacheKey(shopDomain),
    JSON.stringify(status),
    "EX",
    CACHE_TTL_SECONDS,
  );
}

// Precise wait time for a THROTTLED response: how long until the bucket would
// have covered the query we just tried to run.
export async function waitOutThrottle(
  shopDomain: string,
  requestedQueryCost: number,
): Promise<void> {
  const status = await getStatus(shopDomain);
  const available = estimateAvailable(status);
  const deficit = Math.max(0, requestedQueryCost - available);
  const waitMs = Math.ceil((deficit / status.restoreRate) * 1000) || 1000;
  await sleep(Math.min(waitMs, 15_000));
}

export function jitteredBackoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return base / 2 + Math.random() * (base / 2);
}
