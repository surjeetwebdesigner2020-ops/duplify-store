import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listConnectionsForOwner } from "../lib/services/storeConnection.service";
import { MappingsTable } from "../components/mappings/MappingsTable";
import { EmptyState } from "../components/shared/EmptyState";

async function clearOrphanMappings(connectionIds: string[]) {
  if (connectionIds.length === 0) return 0;

  let cleared = 0;
  for (const storeConnectionId of connectionIds) {
    const jobsLeft = await db.migrationJob.count({
      where: { storeConnectionId },
    });
    if (jobsLeft > 0) continue;
    const result = await db.idMapping.deleteMany({
      where: { storeConnectionId },
    });
    cleared += result.count;
  }
  return cleared;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const connections = (await listConnectionsForOwner(shop.id)).filter(
    (connection) => connection.ownerShopId === shop.id,
  );
  const connectionIds = connections.map((c) => c.id);

  // History already deleted but mappings left behind — wipe those orphans.
  const autoCleared = await clearOrphanMappings(connectionIds);

  const url = new URL(request.url);
  const resourceType = url.searchParams.get("resourceType") || undefined;
  const requestedConnectionId =
    url.searchParams.get("connectionId") || undefined;
  // Prevent IDOR: only allow connection IDs owned by this shop.
  const connectionId =
    requestedConnectionId && connectionIds.includes(requestedConnectionId)
      ? requestedConnectionId
      : undefined;
  const search = url.searchParams.get("q") || undefined;
  const cleared =
    url.searchParams.get("cleared") === "1" || autoCleared > 0;

  const rows =
    connectionIds.length === 0
      ? []
      : await db.idMapping.findMany({
          where: {
            storeConnectionId: connectionId ?? { in: connectionIds },
            ...(resourceType ? { resourceType } : {}),
            ...(search
              ? {
                  OR: [
                    {
                      sourceHandle: {
                        contains: search,
                        mode: "insensitive" as const,
                      },
                    },
                    {
                      destinationHandle: {
                        contains: search,
                        mode: "insensitive" as const,
                      },
                    },
                  ],
                }
              : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: 250,
        });

  return {
    cleared,
    autoCleared,
    connections: connections.map((c) => ({
      id: c.id,
      label: `${c.sourceShop.shopDomain} → ${c.destinationShop.shopDomain}`,
    })),
    rows: rows.map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      sourceId: r.sourceId,
      destinationId: r.destinationId,
      sourceHandle: r.sourceHandle,
      destinationHandle: r.destinationHandle,
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent !== "clear") {
    return redirect("/app/mappings");
  }

  const connections = await listConnectionsForOwner(shop.id);
  const connectionIds = connections.map((c) => c.id);
  const connectionId = String(form.get("connectionId") || "");

  if (connectionId) {
    if (!connectionIds.includes(connectionId)) {
      return redirect("/app/mappings");
    }
    await db.idMapping.deleteMany({
      where: { storeConnectionId: connectionId },
    });
  } else if (connectionIds.length > 0) {
    await db.idMapping.deleteMany({
      where: { storeConnectionId: { in: connectionIds } },
    });
  }

  return redirect("/app/mappings?cleared=1");
};

export default function IdMappings() {
  const { connections, rows, cleared, autoCleared } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  if (connections.length === 0) {
    return (
      <s-page heading="ID mappings" inlineSize="large">
        <s-section>
          <EmptyState
            heading="No store pairs yet"
            message="ID mappings appear here once you've connected stores and run a migration."
            action={{ label: "Connect stores", href: "/app/connect" }}
          />
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="ID mappings" inlineSize="large">
      {cleared && (
        <s-banner tone="success" heading="ID mappings cleared">
          <s-paragraph>
            {autoCleared > 0
              ? `Removed ${autoCleared} leftover mapping${autoCleared === 1 ? "" : "s"} because migration history was empty.`
              : "Old mapping data was removed. New migrations will create fresh mappings."}
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Filters">
        <Form method="get">
          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "2 1 240px", minWidth: "200px" }}>
              <s-search-field
                name="q"
                label="Search by handle"
                value={searchParams.get("q") ?? ""}
              ></s-search-field>
            </div>
            <div style={{ flex: "1 1 180px", minWidth: "160px" }}>
              <s-select
                name="resourceType"
                label="Resource type"
                value={searchParams.get("resourceType") ?? ""}
              >
                <s-option value="">Any resource</s-option>
                <s-option value="product">Product</s-option>
                <s-option value="variant">Variant</s-option>
                <s-option value="image">Image</s-option>
                <s-option value="collection">Collection</s-option>
                <s-option value="customer">Customer</s-option>
                <s-option value="page">Page</s-option>
                <s-option value="blog">Blog</s-option>
                <s-option value="article">Article</s-option>
                <s-option value="file">File</s-option>
                <s-option value="menu">Menu</s-option>
                <s-option value="metafield_definition">
                  Metafield definition
                </s-option>
                <s-option value="metaobject_definition">
                  Metaobject definition
                </s-option>
                <s-option value="metaobject">Metaobject</s-option>
                <s-option value="discount">Discount</s-option>
                <s-option value="order">Order</s-option>
                <s-option value="theme">Theme</s-option>
              </s-select>
            </div>
            <div style={{ flex: "1 1 220px", minWidth: "200px" }}>
              <s-select
                name="connectionId"
                label="Store pair"
                value={searchParams.get("connectionId") ?? ""}
              >
                <s-option value="">All store pairs</s-option>
                {connections.map((c) => (
                  <s-option key={c.id} value={c.id}>
                    {c.label}
                  </s-option>
                ))}
              </s-select>
            </div>
            <s-button type="submit">Apply</s-button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Mappings">
        {rows.length === 0 ? (
          <s-paragraph>No ID mappings yet.</s-paragraph>
        ) : (
          <>
            <Form
              method="post"
              style={{ marginBottom: "12px" }}
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    "Clear all ID mappings for this store pair? This cannot be undone.",
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="clear" />
              <input
                type="hidden"
                name="connectionId"
                value={searchParams.get("connectionId") ?? ""}
              />
              <s-button type="submit" variant="secondary" tone="critical">
                Clear all mappings
              </s-button>
            </Form>
            <MappingsTable rows={rows} />
          </>
        )}
      </s-section>
    </s-page>
  );
}
