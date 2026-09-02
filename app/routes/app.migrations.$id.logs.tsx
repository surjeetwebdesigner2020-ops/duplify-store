import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";
import { ProtectedCustomerDataBanner } from "../components/dashboard/ProtectedCustomerDataBanner";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const currentHost = new URL(request.url).searchParams.get("host");
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });

  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
    include: { storeConnection: { include: { sourceShop: true, destinationShop: true } } },
  });
  if (!job) {
    throw redirect("/app/migrations");
  }

  const url = new URL(request.url);
  const level = url.searchParams.get("level") || undefined;
  const search = url.searchParams.get("q") || undefined;

  const logs = await db.migrationLog.findMany({
    where: {
      migrationJobId: job.id,
      level: level as never,
      message: search ? { contains: search, mode: "insensitive" } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const protectedCustomerDataBlocked = Boolean(
    await db.migrationLog.findFirst({
      where: {
        migrationJobId: job.id,
        OR: [
          { message: { contains: "not approved to access the Customer object", mode: "insensitive" } },
          { message: { contains: "protected-customer-data", mode: "insensitive" } },
        ],
      },
      select: { id: true },
    }),
  );

  return {
    jobId: job.id,
    currentShopDomain: session.shop,
    currentHost,
    source: job.storeConnection.sourceShop.shopDomain,
    destination: job.storeConnection.destinationShop.shopDomain,
    protectedCustomerDataBlocked,
    logs: logs.map((l) => ({
      id: l.id,
      level: l.level,
      message: l.message,
      createdAt: l.createdAt,
    })),
  };
};

const LEVEL_TONE: Record<string, "info" | "warning" | "critical" | "neutral"> = {
  INFO: "info",
  WARN: "warning",
  ERROR: "critical",
  DEBUG: "neutral",
};

export default function MigrationLogs() {
  const { jobId, currentShopDomain, currentHost, source, destination, logs, protectedCustomerDataBlocked } = useLoaderData<typeof loader>();
  const errorReportQuery = new URLSearchParams({ shop: currentShopDomain });
  if (currentHost) errorReportQuery.set("host", currentHost);
  const [searchParams] = useSearchParams();

  return (
    <s-page heading="Migration logs" inlineSize="large">
      <s-section heading={`${source} → ${destination}`}>
        <Form method="get">
          <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "2 1 240px", minWidth: "200px" }}>
              <s-search-field name="q" label="Search messages" value={searchParams.get("q") ?? ""}></s-search-field>
            </div>
            <div style={{ flex: "1 1 160px", minWidth: "140px" }}>
              <s-select name="level" label="Level" value={searchParams.get("level") ?? ""}>
                <s-option value="">Any level</s-option>
                <s-option value="INFO">Info</s-option>
                <s-option value="WARN">Warning</s-option>
                <s-option value="ERROR">Error</s-option>
              </s-select>
            </div>
            <s-button type="submit">Apply</s-button>
          </div>
        </Form>
      </s-section>

      {protectedCustomerDataBlocked && (
        <s-section>
          <ProtectedCustomerDataBanner tone="critical" sourceShop={source} />
        </s-section>
      )}

      <s-section heading="Log entries">
        {logs.length === 0 ? (
          <s-paragraph>No log entries match your filters.</s-paragraph>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {logs.map((log) => (
              <div
                key={log.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "12px",
                  flexWrap: "wrap",
                  padding: "12px 14px",
                  border: "1px solid #dcdfe4",
                  borderRadius: "8px",
                  background: "#ffffff",
                }}
              >
                <span style={{ flex: "0 0 170px", color: "#6d7175", fontSize: "13px" }}>
                  {new Date(log.createdAt).toLocaleString()}
                </span>
                <s-badge tone={LEVEL_TONE[log.level] ?? "neutral"}>{log.level}</s-badge>
                <span style={{ flex: "1 1 320px", minWidth: 0, color: "#202223" }}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </s-section>

      <s-section slot="aside" heading="Export">
        <a href={`/api/migrations/${jobId}/errors/csv?${errorReportQuery.toString()}`} download={`migration-${jobId}-errors.csv`}>
          Download error report (CSV)
        </a>
      </s-section>
    </s-page>
  );
}
