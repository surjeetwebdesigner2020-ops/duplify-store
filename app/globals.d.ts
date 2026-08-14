declare module "*.css";

// App Bridge's nav-menu custom element — not part of @shopify/polaris-types
// (which only covers Polaris web components), so it needs its own minimal
// JSX declaration. See https://shopify.dev/docs/api/app-home/using-polaris-components
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": { children?: unknown } & Record<string, unknown>;
  }
}
