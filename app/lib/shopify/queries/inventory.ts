export const LOCATIONS_QUERY = `#graphql
  query duplifyLocations {
    locations(first: 50) {
      edges { node { id name } }
    }
  }
`;

// Bulk export of every variant's inventory levels — run once per migration,
// results are matched back to already-migrated variants via IdMapping.
export const BULK_INVENTORY_QUERY = `
{
  productVariants {
    edges {
      node {
        id
        inventoryItem {
          id
          tracked
          inventoryLevels {
            edges {
              node {
                location { id name }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
}`;
