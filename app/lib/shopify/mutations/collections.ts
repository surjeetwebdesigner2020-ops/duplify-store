export const COLLECTION_CREATE_MUTATION = `#graphql
  mutation duplifyCollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

export interface CollectionCreateInput {
  title: string;
  handle?: string;
  descriptionHtml?: string;
  sortOrder?: string;
  templateSuffix?: string;
  image?: { src: string; altText?: string };
  ruleSet?: {
    appliedDisjunctively: boolean;
    rules: Array<{ column: string; relation: string; condition: string }>;
  };
}

export const COLLECTION_UPDATE_MUTATION = `#graphql
  mutation duplifyCollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

export interface CollectionUpdateInput extends CollectionCreateInput {
  id: string;
}

export const COLLECTION_ADD_PRODUCTS_MUTATION = `#graphql
  mutation duplifyCollectionAddProducts(
    $id: ID!
    $productIds: [ID!]!
  ) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }
`;
