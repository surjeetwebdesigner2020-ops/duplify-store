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
            ... on DiscountCodeFreeShipping {
              title
              startsAt
              endsAt
              appliesOncePerCustomer
              codes(first: 1) { edges { node { code } } }
              minimumRequirement {
                ... on DiscountMinimumSubtotal {
                  greaterThanOrEqualToSubtotal { amount }
                }
              }
              maximumShippingPrice { amount }
            }
            ... on DiscountCodeBxgy {
              title
              startsAt
              endsAt
              appliesOncePerCustomer
              codes(first: 1) { edges { node { code } } }
              customerBuys {
                value {
                  ... on DiscountQuantity { quantity }
                }
              }
              customerGets {
                value {
                  ... on DiscountOnQuantity {
                    effect {
                      ... on DiscountPercentage { percentage }
                    }
                    quantity { quantity }
                  }
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
