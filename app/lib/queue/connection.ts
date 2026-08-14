import IORedis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var redisGlobal: IORedis | undefined;
}

// BullMQ requires maxRetriesPerRequest: null on the connection it's given
// (https://docs.bullmq.io/guide/going-to-production#maxretriesperrequest).
// The same connection is reused for the rate-limiter's throttle-status cache
// (see ../shopify/rate-limiter.ts) so we don't open a second socket per worker.
function createConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required");
  }
  return new IORedis(url, { maxRetriesPerRequest: null });
}

const redis = global.redisGlobal ?? createConnection();

if (process.env.NODE_ENV !== "production") {
  global.redisGlobal = redis;
}

export default redis;
