const SHOPIFY_PROTECTED_CUSTOMER_DATA_URL =
  "https://partners.shopify.com/192111910/apps/410803372033/customer_data";
const SHOPIFY_PROTECTED_CUSTOMER_DATA_GUIDE_URL =
  "https://shopify.dev/docs/apps/launch/protected-customer-data";

export function ProtectedCustomerDataBanner({
  tone = "warning",
  sourceShop,
}: {
  tone?: "info" | "warning" | "critical";
  sourceShop?: string;
}) {
  const sourceApprovalHref = sourceShop
    ? `/auth/external/begin?shop=${encodeURIComponent(sourceShop)}&role=SOURCE`
    : null;

  return (
    <s-banner tone={tone} heading="Customer access must be enabled in Shopify">
      <s-stack direction="block" gap="small-300">
        <s-paragraph>
          Shopify protects customer records. Before migrating customers, the app
          owner must enable protected customer data access for this app.
        </s-paragraph>
        {sourceShop && (
          <s-paragraph>
            Source store: <strong>{sourceShop}</strong>. Customer data will be
            imported from this store after its owner approves customer access.
          </s-paragraph>
        )}
        <ol style={{ margin: "0", paddingLeft: "22px", lineHeight: 1.7 }}>
          <li>Open the Shopify Dev Dashboard.</li>
          <li>
            Go to <strong>Apps → store duplicate → API access requests</strong>.
          </li>
          <li>
            Open <strong>Protected customer data access</strong> and choose
            <strong> Request access</strong>.
          </li>
          <li>
            Select the customer fields used by migration: <strong>Name, Email,
            Phone, and Address</strong>.
          </li>
          <li>
            Save or submit the request. After access is available, reconnect both
            stores and run the customer migration again.
          </li>
        </ol>
        <s-paragraph>
          Suggested reason: “Merchants use this app to migrate customer records
          between Shopify stores they own or administer.”
        </s-paragraph>
      </s-stack>
      {sourceApprovalHref && (
        <s-button
          slot="primary-action"
          href={sourceApprovalHref}
          target="_blank"
        >
          Approve customer access on source store
        </s-button>
      )}
      <s-button
        slot="secondary-actions"
        href={SHOPIFY_PROTECTED_CUSTOMER_DATA_URL}
        target="_blank"
      >
        Open API access requests
      </s-button>
      <s-button
        slot="secondary-actions"
        href={SHOPIFY_PROTECTED_CUSTOMER_DATA_GUIDE_URL}
        target="_blank"
      >
        View Shopify guide
      </s-button>
    </s-banner>
  );
}
