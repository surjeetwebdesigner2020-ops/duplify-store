export type ConflictStrategy = "OVERWRITE" | "SKIP" | "MERGE" | "CREATE_NEW";

export interface ProductBulkPayload {
  parent: {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string | null;
    productType: string | null;
    vendor: string | null;
    tags: string[];
    status: string;
    templateSuffix: string | null;
    seo: { title: string | null; description: string | null } | null;
    options: Array<{ name: string; position: number; values: string[] }>;
  };
  variants: Array<{
    id: string;
    title: string;
    sku: string | null;
    price: string;
    compareAtPrice: string | null;
    barcode: string | null;
    position: number;
    taxable: boolean;
    inventoryPolicy: string;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
  media: Array<{ id: string; alt: string | null; image: { url: string } | null }>;
  metafields: Array<{
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>;
  collectionIds: string[];
}

export interface CollectionBulkPayload {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string | null;
  sortOrder: string | null;
  templateSuffix: string | null;
  image: { url: string; altText: string | null } | null;
  ruleSet: {
    appliedDisjunctively: boolean;
    rules: Array<{ column: string; relation: string; condition: string }>;
  } | null;
}

export interface CustomerBulkPayload {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  tags: string[];
  taxExempt: boolean;
  addresses?: Array<{
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCodeV2: string | null;
    zip: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
  }>;
  defaultAddress?: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCodeV2: string | null;
    zip: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
  } | null;
}

export interface PageBulkPayload {
  id: string;
  title: string;
  handle: string;
  body: string;
  isPublished: boolean;
  templateSuffix: string | null;
}

export interface BlogBulkPayload {
  id: string;
  title: string;
  handle: string;
  templateSuffix: string | null;
}

export interface ArticleBulkPayload {
  id: string;
  blogSourceId: string;
  title: string;
  handle: string;
  body: string;
  summary: string | null;
  tags: string[];
  isPublished: boolean;
  image: { url: string; altText: string | null } | null;
}

export interface FileBulkPayload {
  id: string;
  alt: string | null;
  url: string | null;
  contentType: "IMAGE" | "FILE" | "VIDEO";
}

export interface MetafieldDefinitionBulkPayload {
  ownerType: string;
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
}

export interface MetaobjectDefinitionBulkPayload {
  type: string;
  name: string;
  fieldDefinitions: Array<{ key: string; name: string; type: string; required: boolean }>;
}

export interface MetaobjectEntryBulkPayload {
  id: string;
  definitionType: string;
  handle: string;
  fields: Array<{ key: string; value: string; type: string }>;
}

export interface MenuBulkPayload {
  id: string;
  handle: string;
  title: string;
  items: Array<{
    title: string;
    type: string;
    url: string | null;
    resourceSourceId: string | null;
  }>;
}

export interface DiscountBulkPayload {
  id: string;
  title: string;
  code: string | null;
  startsAt: string;
  endsAt: string | null;
  valueType: "PERCENTAGE" | "FIXED_AMOUNT";
  value: number;
  appliesOncePerCustomer: boolean;
}

export interface OrderBulkPayload {
  id: string;
  name: string;
  email: string | null;
  customerSourceId: string | null;
  currencyCode: string;
  note: string | null;
  tags: string[];
  lineItems: Array<{ title: string; quantity: number; sku: string | null; productVariantSourceId: string | null }>;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCodeV2: string | null;
    zip: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export interface ThemeFileBulkPayload {
  filename: string;
  bodyType: "TEXT" | "BASE64" | "URL";
  value: string;
}
