/**
 * Walking the category tree the server publishes.
 *
 * `GET /storefront/categories` returns the whole active tree in one response,
 * each node carrying its own `children`. That shape is deliberate: the header
 * menu and every category page ask the same query, so the structure is fetched
 * once for the session and the answers below are found in memory rather than
 * over the network.
 *
 * These are lookups, not decisions. Nothing here filters, hides or orders
 * anything — the server has already dropped archived and inactive categories
 * and set the order, and re-deciding any of that here would mean the shop
 * showing something different from what the merchant arranged.
 */

/** One node by handle, anywhere in the tree, or null. */
export function findCategory(tree, handle) {
  if (!handle) return null
  for (const node of tree ?? []) {
    if (node.handle === handle) return node
    const found = findCategory(node.children, handle)
    if (found) return found
  }
  return null
}

/**
 * The handles from the root down to this node, inclusive.
 *
 * Used to decide which branch of the navigation is open. The server sends a
 * breadcrumb with the category detail, so this is not how the page renders its
 * trail — it is how a menu knows it is looking at an ancestor of the page.
 */
export function pathToCategory(tree, handle) {
  for (const node of tree ?? []) {
    if (node.handle === handle) return [node.handle]
    const below = pathToCategory(node.children, handle)
    if (below.length > 0) return [node.handle, ...below]
  }
  return []
}

/** Every node, flattened, with its depth. For a whole-tree menu. */
export function flattenCategories(tree, depth = 0) {
  return (tree ?? []).flatMap((node) => [
    { ...node, depth },
    ...flattenCategories(node.children, depth + 1),
  ])
}
