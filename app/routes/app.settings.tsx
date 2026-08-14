import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  PUBLISHED_SCOPES,
  missingRequestedScopes,
} from "../lib/shopify/scopes";
import { listCustomerDataExports } from "../lib/services/privacyCompliance.server";

/** Scopes we show merchants — protected Partner-only scopes stay out. */
const DISPLAY_SCOPES = PUBLISHED_SCOPES;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, scopes } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  // Keep DB scopes fresh from Shopify so Settings never lies about access.
  let liveScope = shop.scope;
  try {
    const scopeDetails = await scopes.query();
    liveScope = scopeDetails.granted.join(",");
    if (liveScope !== shop.scope) {
      await db.shop.update({
        where: { id: shop.id },
        data: { scope: liveScope },
      });
    }
  } catch {
    // Fall back to stored scope if query fails.
  }

  const setting = await db.appSetting.findUnique({
    where: { shopId: shop.id },
  });
  const connections = await db.storeConnection.findMany({
    where: {
      status: { not: "ARCHIVED" },
      ownerShopId: shop.id,
    },
    select: {
      sourceShop: {
        select: { shopDomain: true, scope: true },
      },
      destinationShop: {
        select: { shopDomain: true, scope: true },
      },
    },
  });

  const stores = new Map<
    string,
    {
      shopDomain: string;
      scope: string;
      roles: Set<"Source" | "Destination">;
      isCurrent: boolean;
    }
  >();

  function addStore(
    connectedShop: { shopDomain: string; scope: string },
    role: "Source" | "Destination",
  ) {
    const existing = stores.get(connectedShop.shopDomain);
    if (existing) {
      existing.roles.add(role);
      if (connectedShop.shopDomain === session.shop) {
        existing.scope = liveScope;
      }
      return;
    }
    stores.set(connectedShop.shopDomain, {
      shopDomain: connectedShop.shopDomain,
      scope:
        connectedShop.shopDomain === session.shop
          ? liveScope
          : connectedShop.scope,
      roles: new Set([role]),
      isCurrent: connectedShop.shopDomain === session.shop,
    });
  }

  addStore({ shopDomain: shop.shopDomain, scope: liveScope }, "Destination");
  for (const connection of connections) {
    addStore(connection.sourceShop, "Source");
    addStore(connection.destinationShop, "Destination");
  }

  return {
    shopDomain: shop.shopDomain,
    scope: liveScope,
    permissionStores: Array.from(stores.values()).map((store) => {
      const missingScopes = missingRequestedScopes(store.scope);
      const grantedCount = DISPLAY_SCOPES.length - missingScopes.length;
      return {
        shopDomain: store.shopDomain,
        roles: Array.from(store.roles),
        isCurrent: store.isCurrent,
        grantedCount,
        requiredCount: DISPLAY_SCOPES.length,
        missingScopes,
      };
    }),
    timezone: setting?.timezone ?? "UTC",
    defaultConflictStrategy:
      (setting?.defaultConflictStrategy as { default?: string } | null)
        ?.default ?? "OVERWRITE",
    privacyExports: await listCustomerDataExports(shop.id),
    privacyPolicyUrl: new URL("/privacy", process.env.SHOPIFY_APP_URL || "https://duplify-store-production-e129.up.railway.app").toString(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const form = await request.formData();

  await db.appSetting.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      timezone: String(form.get("timezone") || "UTC"),
      defaultConflictStrategy: {
        default: String(form.get("defaultConflictStrategy") || "OVERWRITE"),
      },
    },
    update: {
      timezone: String(form.get("timezone") || "UTC"),
      defaultConflictStrategy: {
        default: String(form.get("defaultConflictStrategy") || "OVERWRITE"),
      },
    },
  });

  return { saved: true };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const missingScopes = missingRequestedScopes(data.scope || "");

  // "baseline" is the last-saved value the save bar's dirty check compares
  // against — starts from the loader, and is advanced (not the loader data
  // itself, which useLoaderData treats as read-only) after a successful save.
  const [baseline, setBaseline] = useState({
    timezone: data.timezone,
    defaultConflictStrategy: data.defaultConflictStrategy,
  });

  const [timezone, setTimezone] = useState(baseline.timezone);
  const [defaultConflictStrategy, setDefaultConflictStrategy] = useState(
    baseline.defaultConflictStrategy,
  );

  const isDirty =
    timezone !== baseline.timezone ||
    defaultConflictStrategy !== baseline.defaultConflictStrategy;

  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    function handleExternalOauth(event: MessageEvent) {
      if (event.data?.source === "duplify-external-oauth" && event.data?.ok) {
        revalidator.revalidate();
      }
    }

    window.addEventListener("message", handleExternalOauth);
    return () => window.removeEventListener("message", handleExternalOauth);
  }, [revalidator]);

  function handleSave() {
    fetcher.submit(
      { timezone, defaultConflictStrategy },
      { method: "post" },
    );
  }

  function handleDiscard() {
    setTimezone(baseline.timezone);
    setDefaultConflictStrategy(baseline.defaultConflictStrategy);
  }

  const [savedBannerDismissed, setSavedBannerDismissed] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.saved) {
      setBaseline({ timezone, defaultConflictStrategy });
      setSavedBannerDismissed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <s-page heading="Settings" inlineSize="large">
      {isDirty && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleSave}
          {...(isSaving ? { loading: true } : {})}
        >
          Save
        </s-button>
      )}
      {isDirty && (
        <s-button slot="secondary-actions" onClick={handleDiscard}>
          Discard
        </s-button>
      )}

      {fetcher.data?.saved && !isDirty && !savedBannerDismissed && (
        <s-banner tone="success" heading="Settings saved">
          <s-button
            slot="primary-action"
            onClick={() => setSavedBannerDismissed(true)}
          >
            Dismiss
          </s-button>
        </s-banner>
      )}

      <s-section heading="Admin API permissions">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Duplify installs with full migration access. Write permission also
            covers the matching read permission — merchants should not need to
            re-approve the same data twice.
          </s-paragraph>

          {missingScopes.length === 0 ? (
            <s-banner
              tone="success"
              heading="Ready — all required permissions are in place"
            >
              {data.shopDomain} can run scans and migrations now.
            </s-banner>
          ) : (
            <s-banner tone="warning" heading="A few permissions still need approval">
              <s-paragraph>
                Missing: {missingScopes.join(", ")}
              </s-paragraph>
              <Form method="post" action="/api/scopes/request">
                {missingScopes.map((scope) => (
                  <input
                    key={scope}
                    type="hidden"
                    name="scopes"
                    value={scope}
                  />
                ))}
                <input type="hidden" name="returnTo" value="/app/settings" />
                <s-button
                  slot="primary-action"
                  type="submit"
                  variant="primary"
                >
                  Grant missing permissions
                </s-button>
              </Form>
            </s-banner>
          )}

          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Store</s-table-header>
              <s-table-header listSlot="labeled">Role</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.permissionStores.map((store) => (
                <s-table-row key={store.shopDomain}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">{store.shopDomain}</s-text>
                      {store.isCurrent && (
                        <s-text color="subdued">Current Shopify admin</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{store.roles.join(", ")}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        store.missingScopes.length === 0 ? "success" : "warning"
                      }
                    >
                      {store.missingScopes.length === 0
                        ? "Ready"
                        : "Needs update"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {!store.isCurrent && store.missingScopes.length > 0 ? (
                      <s-link
                        href={`https://admin.shopify.com/store/${store.shopDomain.replace(/\.myshopify\.com$/i, "")}/apps/duplify-store`}
                        target="_blank"
                      >
                        Open store app
                      </s-link>
                    ) : (
                      <s-text color="subdued">-</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      <s-section heading="Defaults">
        <s-stack direction="block" gap="base">
          <s-select
            name="timezone"
            label="Timezone for displayed timestamps"
            value={timezone}
            onChange={(e) => setTimezone(e.currentTarget.value)}
          >
            <s-option value="" disabled>
              Select timezone
            </s-option>
            <s-option value="UTC">UTC</s-option>
            <s-option value="America/New_York">America/New_York</s-option>
            <s-option value="America/Los_Angeles">America/Los_Angeles</s-option>
            <s-option value="Europe/London">Europe/London</s-option>
            <s-option value="Asia/Kolkata">Asia/Kolkata</s-option>
          </s-select>
          <s-select
            name="defaultConflictStrategy"
            label="Default conflict handling for new migrations"
            value={defaultConflictStrategy}
            onChange={(e) => setDefaultConflictStrategy(e.currentTarget.value)}
          >
            <s-option value="" disabled>
              Select conflict handling
            </s-option>
            <s-option value="SKIP">Skip</s-option>
            <s-option value="OVERWRITE">Overwrite</s-option>
            <s-option value="CREATE_NEW">Create new copy</s-option>
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading="Privacy">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Privacy policy:{" "}
            <s-link href={data.privacyPolicyUrl} target="_blank">
              {data.privacyPolicyUrl}
            </s-link>
          </s-paragraph>
          <s-paragraph color="subdued">
            When Shopify sends a customer data request, Duplify stores a
            fulfilled export here for you to download.
          </s-paragraph>
          {data.privacyExports.length === 0 ? (
            <s-paragraph color="subdued">No data requests yet.</s-paragraph>
          ) : (
            <s-stack direction="block" gap="small-200">
              {data.privacyExports.map((item) => (
                <s-box
                  key={item.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">
                      {item.customerEmail ||
                        (item.customerId
                          ? `Customer ${String(item.customerId)}`
                          : "Customer data request")}
                    </s-text>
                    <s-text color="subdued">
                      Fulfilled{" "}
                      {item.processedAt
                        ? new Date(item.processedAt).toLocaleString()
                        : "—"}
                    </s-text>
                    <s-button
                      variant="secondary"
                      onClick={() => {
                        const blob = new Blob(
                          [JSON.stringify(item.export, null, 2)],
                          { type: "application/json" },
                        );
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `duplify-customer-export-${item.id}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download export
                    </s-button>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Always manual">
        <s-unordered-list>
          <s-list-item>Payment gateways &amp; payouts</s-list-item>
          <s-list-item>Domains &amp; billing plan</s-list-item>
          <s-list-item>Staff accounts &amp; permissions</s-list-item>
          <s-list-item>App subscriptions</s-list-item>
          <s-list-item>
            Theme licenses (paid themes must be repurchased)
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
