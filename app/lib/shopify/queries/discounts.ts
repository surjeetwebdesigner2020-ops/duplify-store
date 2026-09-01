// Only DiscountCodeBasic (percentage/fixed-amount-off code discounts) is
// migrated — Shopify's discount schema has many variants (BXGY, free
// shipping, automatic discounts); those are out of scope for this pass and
// are reported as "unsupported" rather than silently dropped.
export const DISCOUNT_CODE_NODES_QUERY = `#graphql
  query duplifyDiscountCodeNodes($after: String) {
    codeDiscountNodes(first: 50, after: $after) {
      edges {
        node {
          id
          codeDiscount {
            __typename
            ... on DiscountCodeBasic {
              title
              startsAt
              endsAt
              appliesOncePerCustomer
              codes(first: 1) { edges { node { code } } }
              customerGets {
                value {
                  ... on DiscountPercentage { percentage }
                  ... on DiscountAmount { amount { amount } }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const DISCOUNT_CODE_BY_CODE_QUERY = `#graphql
  query duplifyDiscountCodeByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) { id }
  }
`;
