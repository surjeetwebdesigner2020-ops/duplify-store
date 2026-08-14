// Customer passwords never transfer (Shopify doesn't expose them via any
// API) — customers created here must reset their password on the
// destination store. This is surfaced in the UI/docs, not hidden.
export const CUSTOMER_CREATE_MUTATION = `#graphql
  mutation duplifyCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id email }
      userErrors { field message }
    }
  }
`;

export interface CustomerCreateInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  note?: string;
  tags?: string[];
  taxExempt?: boolean;
  addresses?: Array<{
    address1?: string;
    address2?: string;
    city?: string;
    provinceCode?: string;
    countryCode?: string;
    zip?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
    company?: string;
  }>;
}
