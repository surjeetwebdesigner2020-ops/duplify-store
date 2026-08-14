export const INVENTORY_SET_QUANTITIES_MUTATION = `#graphql
  mutation duplifyInventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

export interface InventorySetQuantitiesInput {
  name: "available";
  reason: "correction";
  ignoreCompareQuantity: boolean;
  quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number }>;
}
