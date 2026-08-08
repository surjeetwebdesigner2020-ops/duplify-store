import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(fields: string[]): string {
  return fields.map(csvEscape).join(",") + "\r\n";
}

// Deliberately excludes access tokens and any full payload snapshot — only
// enough to identify and act on the failed record.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });

  const { migrationJobForOwnerWhere } = await import("../lib/services/storeConnection.service");
  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
  });
  if (!job) {
    return new Response("Not found", { status: 404 });
  }

  const items = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, status: { in: ["FAILED", "SKIPPED"] } },
    orderBy: [{ resourceType: "asc" }, { createdAt: "asc" }],
  });

  let csv = toCsvRow(["Resource type", "Stage", "Source ID", "Status", "Attempts", "Error"]);
  for (const item of items) {
    csv += toCsvRow([
      item.resourceType,
      item.stage,
      item.sourceId,
      item.status,
      String(item.attempt),
      item.errorMessage ?? "",
    ]);
  }

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="migration-${job.id}-errors.csv"`,
    },
  });
};
