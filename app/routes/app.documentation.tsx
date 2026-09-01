export default function Documentation() {
  return (
    <s-page heading="Documentation" inlineSize="large">
      <s-section heading="What this app does">
        <s-paragraph>
          Duplify Store copies data from one Shopify store (Source) to another
          (Destination) — products, variants, images, inventory, collections,
          customers, pages, blogs, files, menus, metafield definitions,
          metaobjects, discounts, and orders (as draft orders).
        </s-paragraph>
      </s-section>

      <s-section heading="How to use it">
        <s-ordered-list>
          <s-list-item>
            Install Duplify on both stores. On{" "}
            <s-link href="/app/connect">Import / Export</s-link>, request a
            connection — the other store must Accept.
          </s-list-item>
          <s-list-item>
            On <s-link href="/app">Overview</s-link>, choose what to migrate and
            run a pre-migration scan (preview only — nothing is copied yet).
          </s-list-item>
          <s-list-item>Start the migration and watch live progress.</s-list-item>
          <s-list-item>Retry any failed records from the progress page.</s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="Theme migration" id="theme-migration">
        <s-paragraph>
          Full store migration now includes theme files. Duplify creates an
          unpublished destination theme automatically when needed and copies the
          source theme into it, leaving your live theme untouched until you
          publish it from Online Store → Themes.
        </s-paragraph>
        <s-paragraph>
          Only migrate themes you are licensed to use, and be aware that paid
          theme licenses still need to be re-purchased on the destination store.
        </s-paragraph>
      </s-section>

      <s-section heading="If you see “Reconnect store”">
        <s-paragraph>
          Duplify needs an active app connection on both the Source and
          Destination stores. This can happen if a store was uninstalled,
          access was revoked, or its connection expired.
        </s-paragraph>
        <s-ordered-list>
          <s-list-item>
            Click <s-text type="strong">Open store app</s-text> in the warning.
          </s-list-item>
          <s-list-item>
            Sign in to the store named in the warning and open Duplify Store.
          </s-list-item>
          <s-list-item>
            Approve access if Shopify asks, return to the migration, then click{" "}
            <s-text type="strong">Scan again</s-text>.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="What does not migrate">
        <s-unordered-list>
          <s-list-item>Customer passwords</s-list-item>
          <s-list-item>Payment gateways, billing, and domains</s-list-item>
          <s-list-item>Staff accounts</s-list-item>
          <s-list-item>Private data owned by other apps</s-list-item>
          <s-list-item>
            Paid theme licenses (must be purchased again on the destination)
          </s-list-item>
          <s-list-item>
            Orders arrive as draft orders, not exact copies. Without
            read_all_orders approval, Shopify only returns about the last 60
            days of orders.
          </s-list-item>
          <s-list-item>
            Only basic percentage and fixed-amount discount codes (BOGO / free
            shipping not supported yet)
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Need help?" slot="aside">
        <s-paragraph>
          For failed records, open{" "}
          <s-link href="/app/migrations">History</s-link>, check Logs, or
          download the CSV.
        </s-paragraph>
        <s-paragraph>
          Privacy policy:{" "}
          <s-link href="/privacy" target="_blank">
            /privacy
          </s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
