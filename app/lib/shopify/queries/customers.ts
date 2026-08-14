export const BULK_CUSTOMERS_QUERY = `
{
  customers {
    edges {
      node {
        id
        firstName
        lastName
        email
        phone
        note
        tags
        taxExempt
        defaultAddress {
          address1
          address2
          city
          provinceCode
          countryCodeV2
          zip
          phone
          firstName
          lastName
          company
        }
      }
    }
  }
}`;

export const CUSTOMERS_PAGE_QUERY = `#graphql
  query duplifyCustomersPage($after: String) {
    customers(first: 50, after: $after) {
      edges {
        node {
          id
          firstName
          lastName
          email
          phone
          note
          tags
          taxExempt
          defaultAddress {
            address1
            address2
            city
            provinceCode
            countryCodeV2
            zip
            phone
            firstName
            lastName
            company
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const CUSTOMER_BY_EMAIL_QUERY = `#graphql
  query duplifyCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      edges { node { id email } }
    }
  }
`;