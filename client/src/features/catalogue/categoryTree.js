/**
 * Reading the category tree the server publishes.
 *
 * A separate module because these are pure functions, and exporting one beside
 * a component breaks fast refresh — the same reason the admin keeps its label
 * helpers apart.
 */

/**
 * One node's children, found however deep it sits.
 *
 * `/storefront/categories/:handle` returns the node and its breadcrumb but not
 * its children, and the whole tree is already cached — so the children are
 * read from what is in hand rather than fetched again.
 */
export function findChildren(tree, handle) {
  for (const node of tree) {
    if (node.handle === handle) return node.children ?? []
    const found = findChildren(node.children ?? [], handle)
    if (found.length > 0) return found
  }
  return []
}
