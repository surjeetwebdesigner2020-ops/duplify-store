const SHOPIFY_PROTECTED_CUSTOMER_DATA_URL =
  "https://shopify.dev/docs/apps/launch/protected-customer-data";

export function ProtectedCustomerDataBanner({
  tone = "warning",
}: {
  tone?: "info" | "warning" | "critical";
}) {
  return (
    <s-banner tone={tone} heading="Customer access must be enabled in Shopify">
      <s-stack direction="block" gap="small-300">
        <s-paragraph>
          Shopify protects customer records. Before migrating customers, the app
          owner must enable protected customer data access for this app.
        </s-paragraph>
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
        <s-button
          slot="secondary-actions"
          href={SHOPIFY_PROTECTED_CUSTOMER_DATA_URL}
          target="_blank"
          variant="secondary"
        >
          Open Shopify access guide
        </s-button>
      </s-stack>
    </s-banner>
  );
}
