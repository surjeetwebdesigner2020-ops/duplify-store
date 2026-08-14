// productSet creates (or idempotently updates, when `id` is supplied) a
// product together with its options and variants in a single call — Shopify's
// documented pattern for syncing products in from an external system, which
// is exactly what a migration is. Using it instead of productCreate +
// productVariantsBulkCreate keeps a product and all of its variants
// transactionally linked: if this call fails, the product and every one of
// its variants genuinely did not get created, so recording all of them as
// FAILED with the same userError is accurate, not a shortcut.
//
// NOTE: verify this shape against the live GraphiQL schema explorer for the
// installed API version before the first production run — Admin API
// mutation input shapes occasionally gain/rename fields between releases.
export const PRODUCT_SET_MUTATION = `#graphql
  mutation duplifyProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        handle
        variants(first: 250) {
          edges {
            node {
              id
              sku
              selectedOptions { name value }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

export interface ProductSetVariantInput {
  optionValues: Array<{ optionName: string; name: string }>;
  price?: string;
  compareAtPrice?: string;
  sku?: string;
  barcode?: string;
  taxable?: boolean;
  inventoryPolicy?: "DENY" | "CONTINUE";
}

export interface ProductSetMetafieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface ProductSetInput {
  id?: string;
  title: string;
  handle?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
  templateSuffix?: string;
  seo?: { title?: string; description?: string };
  productOptions?: Array<{
    name: string;
    position: number;
    values: Array<{ name: string }>;
  }>;
  variants: ProductSetVariantInput[];
  metafields?: ProductSetMetafieldInput[];
}

export const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation duplifyProductCreateMedia(
    $productId: ID!
    $media: [CreateMediaInput!]!
  ) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        status
        ... on MediaImage {
          image { url }
        }
      }
      mediaUserErrors { field message }
    }
  }
`;
