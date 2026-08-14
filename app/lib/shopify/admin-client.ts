import db from "../../db.server";
import { decryptToken } from "../crypto/token-cipher";
import {
  jitteredBackoffMs,
  recordThrottleStatus,
  sleep,
  waitForBudget,
  waitOutThrottle,
} from "./rate-limiter";

// Keep in sync with `apiVersion` in app/shopify.server.ts. Kept as a plain
// constant (rather than importing shopify.server) so the BullMQ worker
// process doesn't have to construct the full ShopifyApp object just to read
// a version string.
export const ADMIN_API_VERSION = "2026-07";

const MAX_ATTEMPTS = 5;

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown,
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

export class ShopifyAuthError extends Error {
  constructor(
    message: string,
    public readonly shopDomain: string,
  ) {
    super(message);
    this.name = "ShopifyAuthError";
  }
}

export function isShopifyAuthError(error: unknown): error is ShopifyAuthError {
  if (error instanceof ShopifyAuthError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid api key") ||
    message.includes("access token") ||
    message.includes("unrecognized login") ||
    message.includes("returned 401") ||
    message.includes("returned 403")
  );
}

function authErrorForShop(shopDomain: string, detail?: string) {
  return new ShopifyAuthError(
    `Access to ${shopDomain} expired or was revoked${
      detail ? ` (${detail})` : ""
    }. Open Duplify once on that store to reconnect, then run the scan again.`,
    shopDomain,
  );
}

export interface AdminClient {
  shopDomain: string;
  graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    estimatedCost?: number,
  ): Promise<T>;
}

interface GraphqlErrorItem {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlResponseBody<T> {
  data?: T;
  errors?: unknown;
  error?: unknown;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number | null;
      throttleStatus?: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

function normalizeGraphqlErrors(errors: unknown): GraphqlErrorItem[] {
  if (errors == null) return [];

  if (Array.isArray(errors)) {
    return errors.map((entry) => {
      if (typeof entry === "string") return { message: entry };
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const message =
          typeof record.message === "string"
            ? record.message
            : JSON.stringify(entry);
        const extensions =
          record.extensions && typeof record.extensions === "object"
            ? (record.extensions as { code?: string })
            : undefined;
        return { message, extensions };
      }
      return { message: String(entry) };
    });
  }

  if (typeof errors === "string") return [{ message: errors }];

  if (typeof errors === "object") {
    const record = errors as Record<string, unknown>;
    if (typeof record.message === "string") {
      return [{ message: record.message }];
    }
    return [{ message: JSON.stringify(errors) }];
  }

  return [{ message: String(errors) }];
}

function buildClient(shopDomain: string, accessToken: string): AdminClient {
  return {
    shopDomain,
    async graphql<T>(
      query: string,
      variables?: Record<string, unknown>,
      estimatedCost = 50,
    ): Promise<T> {
      let lastError: unknown;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await waitForBudget(shopDomain, estimatedCost);

        let response: Response;
        try {
          response = await fetch(
            `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": accessToken,
              },
              body: JSON.stringify({ query, variables }),
            },
          );
        } catch (error) {
          // Network-level failure — retry with backoff.
          lastError = error;
          await sleep(jitteredBackoffMs(attempt));
          continue;
        }

        if (response.status === 429) {
          const retryAfterSeconds = Number(
            response.headers.get("Retry-After") ?? "2",
          );
          await sleep(Math.min(retryAfterSeconds * 1000, 15_000));
          continue;
        }

        if (response.status >= 500) {
          lastError = new Error(
            `Shopify Admin API returned ${response.status} for ${shopDomain}`,
          );
          await sleep(jitteredBackoffMs(attempt));
          continue;
        }

        let body: GraphqlResponseBody<T>;
        try {
          body = (await response.json()) as GraphqlResponseBody<T>;
        } catch {
          lastError = new Error(
            `Shopify Admin API returned non-JSON ${response.status} for ${shopDomain}`,
          );
          await sleep(jitteredBackoffMs(attempt));
          continue;
        }

        await recordThrottleStatus(shopDomain, body.extensions?.cost);

        const graphqlErrors = normalizeGraphqlErrors(
          body.errors ?? body.error,
        );

        const throttled = graphqlErrors.some(
          (e) => e.extensions?.code === "THROTTLED",
        );
        if (throttled) {
          const requestedCost =
            body.extensions?.cost?.requestedQueryCost ?? estimatedCost;
          await waitOutThrottle(shopDomain, requestedCost);
          continue;
        }

        if (graphqlErrors.length > 0) {
          const message = graphqlErrors.map((e) => e.message).join("; ");
          if (
            /invalid api key|access token|unrecognized login|wrong password/i.test(
              message,
            )
          ) {
            throw authErrorForShop(shopDomain, message);
          }
          throw new ShopifyGraphqlError(message, graphqlErrors);
        }

        if (!response.ok) {
          lastError = new Error(
            `Shopify Admin API returned ${response.status} for ${shopDomain}`,
          );
          // Auth / forbidden responses usually won't succeed on retry.
          if (response.status === 401 || response.status === 403) {
            throw authErrorForShop(
              shopDomain,
              `HTTP ${response.status}`,
            );
          }
          await sleep(jitteredBackoffMs(attempt));
          continue;
        }

        if (body.data == null) {
          throw new ShopifyGraphqlError(
            `Shopify returned empty GraphQL data for ${shopDomain}`,
            [],
          );
        }

        return body.data;
      }

      throw (
        lastError ??
        new Error(
          `Exhausted retries calling Shopify Admin API for ${shopDomain}`,
        )
      );
    },
  };
}

export function createAdminClient(shop: {
  shopDomain: string;
  accessTokenEncrypted: string;
}): AdminClient {
  return buildClient(shop.shopDomain, decryptToken(shop.accessTokenEncrypted));
}

export async function createAdminClientForShopId(
  shopId: string,
): Promise<AdminClient> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  return createAdminClient(shop);
}
