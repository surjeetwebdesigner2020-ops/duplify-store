import db from "../../db.server";

interface CustomerPrivacyPayload {
  shop_id?: number | string;
  shop_domain?: string;
  orders_requested?: Array<number | string>;
  customer?: {
    id?: number | string;
    email?: string | null;
    phone?: string | null;
  };
  data_request?: {
    id?: number | string;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function gid(resource: "Customer" | "Order", id: number | string) {
  return `gid://shopify/${resource}/${String(id)}`;
}

async function connectionAndJobIds(shopId: string) {
  const connections = await db.storeConnection.findMany({
    where: {
      OR: [
        { ownerShopId: shopId },
        { sourceShopId: shopId },
        { destinationShopId: shopId },
      ],
    },
    select: { id: true },
  });
  const connectionIds = connections.map((connection) => connection.id);
  const jobs = await db.migrationJob.findMany({
    where: { storeConnectionId: { in: connectionIds } },
    select: { id: true },
  });

  return {
    connectionIds,
    jobIds: jobs.map((job) => job.id),
  };
}

/**
 * Fulfill customers/data_request: collect PII Duplify holds for this customer
 * and store an export on the webhook event for the merchant (Settings →
 * Privacy requests). Marks the event processed.
 */
export async function recordCustomerDataRequest(
  shopDomain: string,
  topic: string,
  payload: unknown,
) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true, shopDomain: true },
  });
  if (!shop) return;

  const body = payload as CustomerPrivacyPayload;
  const customerId = body.customer?.id;
  const customerEmail = body.customer?.email?.trim().toLowerCase() ?? null;
  const customerPhone = body.customer?.phone?.trim() ?? null;

  const event = await db.webhookEvent.create({
    data: {
      shopId: shop.id,
      topic,
      payload: payload as object,
      processedAt: null,
    },
  });

  if (customerId === undefined) {
    await db.webhookEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        payload: {
          request: payload,
          export: {
            note: "No customer id in request; nothing to export from Duplify.",
            customers: [],
            orders: [],
            mappings: [],
          },
        } as object,
      },
    });
    return;
  }

  const { connectionIds, jobIds } = await connectionAndJobIds(shop.id);
  const customerGid = gid("Customer", customerId);
  const orderGids = (body.orders_requested ?? []).map((id) => gid("Order", id));

  const candidateItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: { in: jobIds },
      resourceType: { in: ["customer", "order"] },
    },
    select: {
      id: true,
      resourceType: true,
      sourceId: true,
      destinationId: true,
      status: true,
      payload: true,
      migrationJobId: true,
    },
  });

  const customers: unknown[] = [];
  const orders: unknown[] = [];

  for (const item of candidateItems) {
    const stored = asRecord(item.payload);
    if (item.resourceType === "customer") {
      const email =
        typeof stored.email === "string" ? stored.email.toLowerCase() : null;
      if (
        item.sourceId === customerGid ||
        (customerEmail && email === customerEmail)
      ) {
        customers.push({
          migrationItemId: item.id,
          migrationJobId: item.migrationJobId,
          sourceId: item.sourceId,
          destinationId: item.destinationId,
          status: item.status,
          // Only fields Duplify persisted — not a full Shopify customer dump.
          storedFields: {
            email: stored.email ?? null,
            firstName: stored.firstName ?? null,
            lastName: stored.lastName ?? null,
            phone: stored.phone ?? null,
          },
        });
      }
      continue;
    }

    const storedEmail =
      typeof stored.email === "string" ? stored.email.toLowerCase() : null;
    if (
      orderGids.includes(item.sourceId) ||
      stored.customerSourceId === customerGid ||
      (customerEmail !== null && storedEmail === customerEmail)
    ) {
      orders.push({
        migrationItemId: item.id,
        migrationJobId: item.migrationJobId,
        sourceId: item.sourceId,
        destinationId: item.destinationId,
        status: item.status,
        storedFields: {
          email: stored.email ?? null,
          customerSourceId: stored.customerSourceId ?? null,
          name: stored.name ?? null,
        },
      });
    }
  }

  const mappings = await db.idMapping.findMany({
    where: {
      storeConnectionId: { in: connectionIds },
      OR: [
        { sourceId: customerGid },
        { destinationId: customerGid },
        ...(orderGids.length
          ? [
              { sourceId: { in: orderGids } },
              { destinationId: { in: orderGids } },
            ]
          : []),
      ],
    },
    select: {
      resourceType: true,
      sourceId: true,
      destinationId: true,
      sourceHandle: true,
      destinationHandle: true,
      updatedAt: true,
    },
  });

  const exportPayload = {
    fulfilledAt: new Date().toISOString(),
    shopDomain: shop.shopDomain,
    dataRequestId: body.data_request?.id ?? null,
    customer: {
      id: customerId,
      gid: customerGid,
      email: customerEmail,
      phone: customerPhone,
    },
    note:
      "This export contains only data Duplify Store retained during migrations (IDs, handles, and fields stored in migration payloads). It is not a full Shopify Admin customer export.",
    customers,
    orders,
    mappings,
  };

  await db.webhookEvent.update({
    where: { id: event.id },
    data: {
      processedAt: new Date(),
      payload: {
        request: payload,
        export: exportPayload,
      } as object,
    },
  });

  console.log(
    `Fulfilled customers/data_request for ${shopDomain}: ${customers.length} customer row(s), ${orders.length} order row(s), ${mappings.length} mapping(s)`,
  );
}

export async function listCustomerDataExports(shopId: string) {
  const events = await db.webhookEvent.findMany({
    where: {
      shopId,
      topic: {
        in: ["CUSTOMERS_DATA_REQUEST", "customers/data_request"],
      },
      processedAt: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return events.map((event) => {
    const payload = asRecord(event.payload);
    const exportData = asRecord(payload.export);
    return {
      id: event.id,
      createdAt: event.createdAt.toISOString(),
      processedAt: event.processedAt?.toISOString() ?? null,
      customerEmail:
        typeof asRecord(exportData.customer).email === "string"
          ? String(asRecord(exportData.customer).email)
          : null,
      customerId: asRecord(exportData.customer).id ?? null,
      export: exportData,
    };
  });
}

export async function redactCustomerData(
  shopDomain: string,
  payload: {
    customer?: {
      id?: number | string;
      email?: string | null;
    };
    orders_to_redact?: Array<number | string>;
  },
) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop || payload.customer?.id === undefined) return;

  const { connectionIds, jobIds } = await connectionAndJobIds(shop.id);
  const customerGid = gid("Customer", payload.customer.id);
  const orderGids = (payload.orders_to_redact ?? []).map((id) =>
    gid("Order", id),
  );
  const customerEmail = payload.customer.email?.trim().toLowerCase() ?? null;

  const candidateItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: { in: jobIds },
      resourceType: { in: ["customer", "order"] },
    },
    select: {
      id: true,
      resourceType: true,
      sourceId: true,
      payload: true,
    },
  });

  const itemIds = candidateItems
    .filter((item) => {
      if (item.resourceType === "customer") {
        return item.sourceId === customerGid;
      }

      const stored = asRecord(item.payload);
      const storedEmail =
        typeof stored.email === "string" ? stored.email.toLowerCase() : null;
      return (
        orderGids.includes(item.sourceId) ||
        stored.customerSourceId === customerGid ||
        (customerEmail !== null && storedEmail === customerEmail)
      );
    })
    .map((item) => item.id);

  await db.$transaction([
    db.migrationItem.deleteMany({ where: { id: { in: itemIds } } }),
    db.idMapping.deleteMany({
      where: {
        storeConnectionId: { in: connectionIds },
        OR: [
          { sourceId: customerGid },
          { destinationId: customerGid },
          { sourceId: { in: orderGids } },
          { destinationId: { in: orderGids } },
        ],
      },
    }),
    db.conflict.deleteMany({
      where: {
        storeConnectionId: { in: connectionIds },
        OR: [{ sourceId: customerGid }, { matchedDestinationId: customerGid }],
      },
    }),
    ...(customerEmail
      ? [
          db.migrationLog.deleteMany({
            where: {
              migrationJobId: { in: jobIds },
              message: { contains: customerEmail, mode: "insensitive" },
            },
          }),
        ]
      : []),
    db.webhookEvent.deleteMany({
      where: {
        shopId: shop.id,
        topic: {
          in: ["CUSTOMERS_DATA_REQUEST", "customers/data_request"],
        },
      },
    }),
  ]);
}

export async function redactShopData(shopDomain: string) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    await db.session.deleteMany({ where: { shop: shopDomain } });
    return;
  }

  const { connectionIds, jobIds } = await connectionAndJobIds(shop.id);

  await db.$transaction([
    db.conflict.deleteMany({
      where: { storeConnectionId: { in: connectionIds } },
    }),
    db.migrationLog.deleteMany({
      where: { migrationJobId: { in: jobIds } },
    }),
    db.migrationItem.deleteMany({
      where: { migrationJobId: { in: jobIds } },
    }),
    db.migrationJob.deleteMany({ where: { id: { in: jobIds } } }),
    db.idMapping.deleteMany({
      where: { storeConnectionId: { in: connectionIds } },
    }),
    db.storeConnection.deleteMany({ where: { id: { in: connectionIds } } }),
    db.appSetting.deleteMany({ where: { shopId: shop.id } }),
    db.webhookEvent.deleteMany({ where: { shopId: shop.id } }),
    db.session.deleteMany({ where: { shop: shopDomain } }),
    db.shop.delete({ where: { id: shop.id } }),
  ]);
}
