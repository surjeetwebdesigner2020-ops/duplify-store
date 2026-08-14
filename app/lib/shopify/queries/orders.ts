// Real historical order creation is a restricted/protected Admin API
// capability most apps aren't granted — this exports enough to recreate
// orders as DRAFT orders on the destination (see mutations/orders.ts), which
// is the best-effort, always-available path. Original order numbers,
// timestamps, and payment/fulfillment state do not carry over.
export const BULK_ORDERS_QUERY = `
{
  orders {
    edges {
      node {
        id
        name
        email
        currencyCode
        note
        tags
        customer { id }
        shippingAddress {
          address1
          address2
          city
          provinceCode
          countryCodeV2
          zip
          firstName
          lastName
        }
        lineItems {
          edges {
            node {
              title
              quantity
              sku
              variant { id }
            }
          }
        }
      }
    }
  }
}`;
