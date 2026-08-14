/**
 * Public privacy policy for Duplify Store (Shopify App Store / GDPR).
 * Hosted at /privacy — also link this URL in Partner Dashboard listing.
 */
export default function PrivacyPolicy() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        color: "#202223",
        lineHeight: 1.55,
      }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: "#6d7175", marginTop: 0 }}>
        Duplify Store · Last updated: August 7, 2026
      </p>

      <h2>Who we are</h2>
      <p>
        Duplify Store (“Duplify”, “we”, “us”) is a Shopify app that helps
        merchants copy catalog and store content from one Shopify store to
        another. Contact:{" "}
        <a
          href="mailto:support@duplify.store"
          target="_blank"
          rel="noopener noreferrer"
        >
          support@duplify.store
        </a>.
      </p>

      <h2>Data we process</h2>
      <p>When you install and use Duplify, we may process:</p>
      <ul>
        <li>
          Shop domain, offline access token (encrypted at rest), and granted
          Admin API scopes
        </li>
        <li>
          Migration job configuration, progress logs, and ID mappings between
          source and destination resources
        </li>
        <li>
          Resource payloads required to perform a migration (for example product
          titles, handles, customer emails when customers are selected, theme
          files)
        </li>
        <li>Webhook event receipts required for Shopify compliance topics</li>
      </ul>

      <h2>How we use data</h2>
      <p>We use this data only to:</p>
      <ul>
        <li>Authenticate your shops and run requested migrations</li>
        <li>Show progress, history, and ID mappings inside the app</li>
        <li>Respond to Shopify mandatory privacy webhooks</li>
        <li>Operate, secure, and improve the service</li>
      </ul>
      <p>
        We do not sell personal data. We do not use store customer data for
        advertising.
      </p>

      <h2>Sharing</h2>
      <p>
        Data is processed on our hosting providers (application, database, and
        queue infrastructure) solely to run Duplify. Shopify receives API calls
        you authorize via the app’s scopes.
      </p>

      <h2>Retention</h2>
      <p>
        Access tokens are cleared when you uninstall. Remaining shop-linked data
        is purged when Shopify sends the shop/redact webhook (typically within
        about 48 hours of uninstall). Customer redaction webhooks delete
        matching migration items, mappings, and related logs.
      </p>

      <h2>Your rights / GDPR</h2>
      <p>
        Store owners can disconnect store pairs, clear ID mappings, and
        uninstall the app at any time. Customer data requests and redactionsactions
        requests from Shopify are handled via the mandatory compliance webhooks;
        fulfilled data-request exports are available to the store owner inside
        Duplify under Settings → Privacy requests.
      </p>

      <h2>Security</h2>
      <p>
        Offline tokens are encrypted before storage. Pairing another store
        requires mutual consent from both shops. Access to migration data is
        scoped to shops that own or participate in a connection.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy as the product evolves. Material changes will
        be reflected on this page with an updated date.
      </p>

      <p style={{ marginTop: 40, color: "#6d7175", fontSize: 14 }}>
        Partner Dashboard privacy policy URL:{" "}
        <code>/privacy</code> on your Duplify app host (for example{" "}
        <code>https://duplify-store-production-e129.up.railway.app/privacy</code>).
      </p>
    </main>
  );
}
