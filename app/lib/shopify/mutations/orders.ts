export const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation duplifyDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

export interface DraftOrderInput {
  email?: string;
  note2?: string;
  tags?: string[];
  customerId?: string;
  shippingAddress?: {
    address1?: string;
    address2?: string;
    city?: string;
    provinceCode?: string;
    countryCode?: string;
    zip?: string;
    firstName?: string;
    lastName?: string;
  };
  lineItems: Array<{ title?: string; variantId?: string; quantity: number }>;
}
