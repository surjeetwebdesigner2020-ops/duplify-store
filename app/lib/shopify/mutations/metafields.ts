export const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation duplifyMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message }
    }
  }
`;

export interface MetafieldDefinitionInput {
  name: string;
  namespace: string;
  key: string;
  description?: string;
  type: string;
  ownerType: string;
}

/** Sets values independently from productSet so one protected metafield
 * cannot make the parent product migration fail. */
export const METAFIELDS_SET_MUTATION = `#graphql
  mutation duplifyMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message code }
    }
  }
`;

export interface MetafieldsSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}
