export function ProtectedCustomerDataBanner({
  tone = "warning",
}: {
  tone?: "info" | "warning" | "critical";
  sourceShop?: string;
}) {
  return (
    <s-banner tone={tone} heading="Customer migration is not available yet">
      <s-paragraph>
        Shopify is still verifying customer-data access for this app. Your
        stores are connected correctly, and no action is required from the
        source-store owner. Please try customer migration again after access is
        enabled.
      </s-paragraph>
    </s-banner>
  );
}
