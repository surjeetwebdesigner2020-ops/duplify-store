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

export const CUSTOMER_UPDATE_MUTATION = `#graphql
  mutation duplifyCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id email phone }
      userErrors { field message }
    }
  }
`;

export const CUSTOMER_EMAIL_CONSENT_UPDATE_MUTATION = `#graphql
  mutation duplifyCustomerEmailConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

export const CUSTOMER_SMS_CONSENT_UPDATE_MUTATION = `#graphql
  mutation duplifyCustomerSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

export interface CustomerCreateInput {
  id?: string;
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
  metafields?: Array<{ namespace: string; key: string; type: string; value: string }>;
}
