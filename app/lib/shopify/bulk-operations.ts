import type { AdminClient } from "./admin-client";
import { sleep } from "./rate-limiter";
import { asArray, joinUserErrors } from "./graphql-safe";

// Shopify's Bulk Operations API: submit a query, poll until Shopify finishes
// exporting it to a JSONL file, then stream that file back. This is the only
// practical way to read "all products" (or customers/orders/etc.) out of a
// large store without paging through cursors one 250-record page at a time.
// https://shopify.dev/docs/api/usage/bulk-operations/queries

const POLL_INTERVAL_START_MS = 1000;
const POLL_INTERVAL_MAX_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — generous for very large catalogs

interface BulkOperationNode {
  id: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "CANCELED" | "FAILED" | "EXPIRED";
  errorCode: string | null;
  objectCount: string;
  url: string | null;
  partialDataUrl: string | null;
}

interface BulkOperationRunQueryResponse {
  bulkOperationRunQuery: {
    bulkOperation: { id: string; status: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  } | null;
}

interface CurrentBulkOperationResponse {
  currentBulkOperation: BulkOperationNode | null;
}

export class BulkOperationError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string | null,
  ) {
    super(message);
    this.name = "BulkOperationError";
  }
}

export async function runBulkQuery(
  admin: AdminClient,
  query: string,
): Promise<BulkOperationNode> {
  const startResult = await admin.graphql<BulkOperationRunQueryResponse>(
    `#graphql
    mutation duplifyBulkOperationRunQuery($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query },
    10,
  );

  const payload = startResult.bulkOperationRunQuery;
  if (!payload) {
    throw new BulkOperationError(
      "Shopify did not return bulkOperationRunQuery",
      null,
    );
  }

  const userErrors = asArray<{ field: string[]; message: string }>(
    payload.userErrors,
  );
  if (userErrors.length > 0) {
    throw new BulkOperationError(
      joinUserErrors(userErrors, "Bulk operation user error"),
      "USER_ERROR",
    );
  }
  if (!payload.bulkOperation) {
    throw new BulkOperationError("Shopify did not return a bulk operation", null);
  }

  return pollUntilFinished(admin);
}

async function pollUntilFinished(admin: AdminClient): Promise<BulkOperationNode> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let intervalMs = POLL_INTERVAL_START_MS;

  while (Date.now() < deadline) {
    const result = await admin.graphql<CurrentBulkOperationResponse>(
      `#graphql
      query duplifyCurrentBulkOperation {
        currentBulkOperation {
          id
          status
          errorCode
          objectCount
          url
          partialDataUrl
        }
      }`,
      undefined,
      5,
    );

    const op = result.currentBulkOperation;
    if (!op) {
      throw new BulkOperationError("No bulk operation is running", null);
    }

    if (op.status === "COMPLETED") return op;
    if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
      throw new BulkOperationError(
        `Bulk operation ended with status ${op.status}${
          op.errorCode ? ` (${op.errorCode})` : ""
        }`,
        op.errorCode,
      );
    }

    await sleep(intervalMs);
    intervalMs = Math.min(intervalMs * 1.5, POLL_INTERVAL_MAX_MS);
  }

  throw new BulkOperationError("Bulk operation timed out", "TIMEOUT");
}

// Parses the newline-delimited JSON export. Child records (variants, images,
// etc. from a nested connection in the bulk query) come back as flat objects
// tagged with `__parentId`, one per line, interleaved with their parent —
// groupByParent reassembles them.
export async function* streamBulkResults(
  url: string,
): AsyncGenerator<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new BulkOperationError(
      `Failed to download bulk operation result: ${response.status}`,
      null,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          yield JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Skip corrupt JSONL lines rather than killing the whole export.
        }
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    try {
      yield JSON.parse(trailing) as Record<string, unknown>;
    } catch {
      // Skip trailing corrupt line.
    }
  }
}

export interface GroupedBulkRecord {
  parent: Record<string, unknown>;
  childrenByField: Record<string, Record<string, unknown>[]>;
}

// Groups a flat bulk-result stream into { parent, childrenByField } records,
// keyed off Shopify's `__parentId` convention. `childField` maps the GraphQL
// connection field name (e.g. "variants") to the object `id` prefix Shopify
// uses for that node type isn't needed — Shopify already tags children with
// `__parentId`, so grouping only needs the parent's own id.
export async function collectGroupedBulkResults(
  url: string,
): Promise<GroupedBulkRecord[]> {
  const parents = new Map<string, GroupedBulkRecord>();
  const orphanedChildren: Record<string, unknown>[] = [];

  for await (const record of streamBulkResults(url)) {
    const parentId = record.__parentId as string | undefined;
    if (!parentId) {
      parents.set(record.id as string, { parent: record, childrenByField: {} });
      continue;
    }

    const parentEntry = parents.get(parentId);
    if (!parentEntry) {
      // Shopify streams parents before their children, but guard against
      // out-of-order delivery rather than silently dropping data.
      orphanedChildren.push(record);
      continue;
    }

    const field = inferConnectionField(record);
    parentEntry.childrenByField[field] ??= [];
    parentEntry.childrenByField[field].push(record);
  }

  for (const child of orphanedChildren) {
    const parentId = child.__parentId as string;
    const parentEntry = parents.get(parentId);
    if (parentEntry) {
      const field = inferConnectionField(child);
      parentEntry.childrenByField[field] ??= [];
      parentEntry.childrenByField[field].push(child);
    }
  }

  return Array.from(parents.values());
}

// Bulk JSONL doesn't label which connection field a child came from, only its
// own `id` (a Shopify GID like gid://shopify/ProductVariant/123). Use the GID
// resource segment as the grouping key so callers can look up
// `childrenByField["ProductVariant"]` etc.
function inferConnectionField(record: Record<string, unknown>): string {
  const id = record.id as string | undefined;
  if (!id) return "unknown";
  const match = /^gid:\/\/shopify\/([^/]+)\//.exec(id);
  return match ? match[1] : "unknown";
}
