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

export const DISCOUNT_CODE_FREE_SHIPPING_CREATE_MUTATION = `#graphql
  mutation duplifyDiscountCodeFreeShippingCreate($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export const DISCOUNT_CODE_FREE_SHIPPING_UPDATE_MUTATION = `#graphql
  mutation duplifyDiscountCodeFreeShippingUpdate($id: ID!, $freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingUpdate(id: $id, freeShippingCodeDiscount: $freeShippingCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export const DISCOUNT_CODE_BXGY_CREATE_MUTATION = `#graphql
  mutation duplifyDiscountCodeBxgyCreate($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
    discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export const DISCOUNT_CODE_BXGY_UPDATE_MUTATION = `#graphql
  mutation duplifyDiscountCodeBxgyUpdate($id: ID!, $bxgyCodeDiscount: DiscountCodeBxgyInput!) {
    discountCodeBxgyUpdate(id: $id, bxgyCodeDiscount: $bxgyCodeDiscount) {
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

export interface DiscountCodeFreeShippingInput {
  title: string;
  code: string;
  startsAt: string;
  endsAt?: string;
  appliesOncePerCustomer: boolean;
  minimumRequirement?: {
    subtotal?: { greaterThanOrEqualToSubtotal: number };
  };
  customerSelection: { all: boolean };
  destination: { all: boolean };
  maximumShippingPrice?: { amount: string };
}

export interface DiscountCodeBxgyInput {
  title: string;
  code: string;
  startsAt: string;
  endsAt?: string;
  appliesOncePerCustomer: boolean;
  customerBuys: {
    value: { quantity: string };
    items: { all: boolean };
  };
  customerGets: {
    value: {
      discountOnQuantity: {
        effect: { percentage?: number; amount?: { amount: string } };
        quantity: { quantity: string };
      };
    };
    items: { all: boolean };
  };
  customerSelection: { all: boolean };
}
