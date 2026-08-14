export const METAOBJECT_DEFINITION_CREATE_MUTATION = `#graphql
  mutation duplifyMetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message }
    }
  }
`;

export interface MetaobjectDefinitionCreateInput {
  type: string;
  name: string;
  fieldDefinitions: Array<{ key: string; name: string; type: string; required: boolean }>;
}

export const METAOBJECT_CREATE_MUTATION = `#graphql
  mutation duplifyMetaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message }
    }
  }
`;

export interface MetaobjectCreateInput {
  type: string;
  handle?: string;
  fields: Array<{ key: string; value: string }>;
}
