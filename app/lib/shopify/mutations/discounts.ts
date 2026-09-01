export const DISCOUNT_CODE_BASIC_CREATE_MUTATION = `#graphql
  mutation duplifyDiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export const DISCOUNT_CODE_BASIC_UPDATE_MUTATION = `#graphql
  mutation duplifyDiscountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export interface DiscountCodeBasicInput {
  title: string;
  code: string;
  startsAt: string;
  endsAt?: string;
  appliesOncePerCustomer: boolean;
  customerGets: {
    value: { percentage?: number; discountAmount?: { amount: string; appliesOnEachItem: boolean } };
    items: { all: boolean };
  };
  customerSelection: { all: boolean };
}
