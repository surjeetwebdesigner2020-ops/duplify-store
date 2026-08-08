import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import {
  BULK_CUSTOMERS_QUERY,
  CUSTOMERS_PAGE_QUERY,
  CUSTOMER_BY_EMAIL_QUERY,
} from "../../shopify/queries/customers";
import { CUSTOMER_CREATE_MUTATION, type CustomerCreateInput } from "../../shopify/mutations/customers";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ConflictStrategy, CustomerBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

function normalizeCustomerPayload(
  raw: CustomerBulkPayload,
): CustomerBulkPayload {
  if (raw.addresses && raw.addresses.length > 0) return raw;
  if (raw.defaultAddress) {
    return { ...raw, addresses: [raw.defaultAddress] };
  }
  return { ...raw, addresses: [] };
}

// Small retry helper for transient network/HTTP errors (rate limits, timeouts, 5xx)
const RETRY_ATTEMPTS = 3;
function isRetriableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  return /ECONNRESET|ETIMEDOUT|429|502|503|504|ECONNREFUSED|ENOTFOUND|timeout|timed out|Failed to fetch|Network request failed/i.test(msg);
}

async function retry<T>(fn: () => Promise<T>, attempts = RETRY_ATTEMPTS): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetriableError(e) || i === attempts - 1) break;
      const delay = 500 * Math.pow(2, i); // 500ms, 1000ms, 2000ms
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function fetchCustomersByPages(
  sourceAdmin: ReturnType<typeof createAdminClient>,
): Promise<CustomerBulkPayload[]> {
  const customers: CustomerBulkPayload[] = [];
  let after: string | null = null;

  do {
    const result: {
      customers?: {
        edges?: Array<{ node: CustomerBulkPayload }>;
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await sourceAdmin.graphql(CUSTOMERS_PAGE_QUERY, { after }, 25);

    for (const edge of result.customers?.edges ?? []) {
      if (edge?.node) customers.push(normalizeCustomerPayload(edge.node));
    }
    after = result.customers?.pageInfo?.hasNextPage
      ? result.customers.pageInfo.endCursor
      : null;
  } while (after);

  return customers;
}

export async function ensureCustomerItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({
    where: { migrationJobId: job.id, resourceType: "customer" },
  });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting customers from source store");

  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  let customers: CustomerBulkPayload[] = [];

  try {
    const op = await runBulkQuery(sourceAdmin, BULK_CUSTOMERS_QUERY);
    if (!op.url) {
      await logEvent(job.id, "INFO", "Source store has no customers to migrate");
      return;
    }
    const grouped = await collectGroupedBulkResults(op.url);
    customers = grouped.map((record) =>
      normalizeCustomerPayload(record.parent as unknown as CustomerBulkPayload),
    );
  } catch (error) {
    await logEvent(
      job.id,
      "WARN",
      `Customer bulk export failed; falling back to paginated export: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    customers = await fetchCustomersByPages(sourceAdmin);
  }

  const rows = customers.map((customer) => ({
    migrationJobId: job.id,
    resourceType: "customer",
    stage: "customers",
    sourceId: customer.id,
    status: "PENDING" as const,
    payload: customer as unknown as object,
  }));

  if (rows.length > 0) {
    await db.migrationItem.createMany({ data: rows });
  }
  await logEvent(job.id, "INFO", `Found ${rows.length} customers to migrate`);
}

interface CustomerCreateResponse {
  customerCreate: {
    customer: { id: string; email: string | null } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

interface CustomerByEmailResponse {
  customers: { edges: Array<{ node: { id: string; email: string | null } }> };
}

export async function runCustomersStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureCustomerItems(job);

  const conflictStrategy: ConflictStrategy =
    (job.conflictStrategy as Record<string, ConflictStrategy>).customers ?? "SKIP";

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "customer",
      status: { in: ["PENDING", "RETRYING"] },
    },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    await processCustomerItem(job, item, destAdmin, conflictStrategy);
  }
}

async function processCustomerItem(
  job: MigrationJobWithConnection,
  item: { id: string; sourceId: string; attempt: number; payload: unknown },
  destAdmin: ReturnType<typeof createAdminClient>,
  conflictStrategy: ConflictStrategy,
): Promise<void> {
  const customer = item.payload as unknown as CustomerBulkPayload;
  const storeConnectionId = job.storeConnectionId;

  await db.migrationItem.update({
    where: { id: item.id },
    data: { status: "PROCESSING", attempt: item.attempt + 1 },
  });

  const alreadyMapped = await getLiveMapping(
    destAdmin,
    storeConnectionId,
    "customer",
    item.sourceId,
  );
  if (alreadyMapped) {
    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null },
    });
    return;
  }

  if (!customer.email) {
    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "SKIPPED", errorMessage: "Customer has no email address (dedup key required)" },
    });
    return;
  }

  let existingDestinationId: string | null = null;
  try {
    const existing = await retry(() =>
      destAdmin.graphql<CustomerByEmailResponse>(
        CUSTOMER_BY_EMAIL_QUERY,
        { query: `email:'${customer.email.replace(/'/g, "")}'` },
        5,
      ),
    );
    existingDestinationId = existing.customers.edges[0]?.node.id ?? null;
  } catch (error) {
    await fail(job.id, item.id, `Conflict check failed: ${errMsg(error)}`);
    return;
  }

  if (existingDestinationId && conflictStrategy === "SKIP") {
    await saveMapping({
      storeConnectionId,
      resourceType: "customer",
      sourceId: item.sourceId,
      destinationId: existingDestinationId,
    });
    await db.migrationItem.update({
      where: { id: item.id },
      data: {
        status: "SKIPPED",
        destinationId: existingDestinationId,
        errorMessage: "Customer with this email already exists on the destination store",
      },
    });
    return;
  }

  if (existingDestinationId && conflictStrategy !== "CREATE_NEW") {
    // Customers can't be "overwritten" via customerCreate — map to the
    // existing record so downstream stages (e.g. Orders) can still reference it.
    await saveMapping({
      storeConnectionId,
      resourceType: "customer",
      sourceId: item.sourceId,
      destinationId: existingDestinationId,
    });
    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "COMPLETED", destinationId: existingDestinationId, errorMessage: null },
    });
    return;
  }

  const input: CustomerCreateInput = {
    firstName: customer.firstName ?? undefined,
    lastName: customer.lastName ?? undefined,
    email: customer.email,
    phone: customer.phone ?? undefined,
    note: customer.note ?? undefined,
    tags: customer.tags,
    taxExempt: customer.taxExempt,
    addresses: (customer.addresses ?? []).map((a) => ({
      address1: a.address1 ?? undefined,
      address2: a.address2 ?? undefined,
      city: a.city ?? undefined,
      provinceCode: a.provinceCode ?? undefined,
      countryCode: a.countryCodeV2 ?? undefined,
      zip: a.zip ?? undefined,
      phone: a.phone ?? undefined,
      firstName: a.firstName ?? undefined,
      lastName: a.lastName ?? undefined,
      company: a.company ?? undefined,
    })),
  };

  try {
    const result = await retry(() =>
      destAdmin.graphql<CustomerCreateResponse>(
        CUSTOMER_CREATE_MUTATION,
        { input },
        20,
      ),
    );

    if (
      !result.customerCreate ||
      (result.customerCreate.userErrors?.length ?? 0) > 0 ||
      !result.customerCreate.customer
    ) {
      const message = joinUserErrors(
        result.customerCreate?.userErrors,
        "Unknown customerCreate error",
      );
      await fail(job.id, item.id, message);
      return;
    }

    const destinationId = result.customerCreate.customer.id;
    await saveMapping({ storeConnectionId, resourceType: "customer", sourceId: item.sourceId, destinationId });
    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "COMPLETED", destinationId, errorMessage: null },
    });
    await logEvent(job.id, "INFO", `Migrated customer "${customer.email}"`, { sourceId: item.sourceId });
  } catch (error) {
    await fail(job.id, item.id, errMsg(error));
  }
}

async function fail(migrationJobId: string, itemId: string, message: string): Promise<void> {
  await db.migrationItem.update({ where: { id: itemId }, data: { status: "FAILED", errorMessage: message } });
  await logEvent(migrationJobId, "ERROR", message, { itemId });
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
