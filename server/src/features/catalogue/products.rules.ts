/**
 * The product field catalogue, for smart collections (§4).
 *
 * The vocabulary a merchant may build a collection from. The compiler, the
 * operator table and the coercion live in `shared/rules`; this file says which
 * questions can be asked about a product and what SQL each one stands for —
 * exactly as `customers/segments.rules.ts` does for people.
 *
 * ── Why several of these are subqueries ──────────────────────────────────────
 *
 * The three things a merchant most wants to group on — price, stock and SKU —
 * are not columns on `products`. The variant is the purchasable unit, so price
 * and SKU live there, and stock lives further out on `inventory_levels`. Rather
 * than teach the compiler about joins, each is written here as a scalar
 * subquery: the engine needs one mechanism, and a field is still just an
 * expression.
 *
 * That costs a correlated subquery per condition. It is the right trade at shop
 * scale — a collection is read far less often than a product page — and the
 * indexes in 0024 are there for the ones that matter.
 *
 * ── Price is the *lowest* variant price ──────────────────────────────────────
 *
 * "Under £50" means the shopper can buy something for under £50, not that every
 * size costs less than £50. A shirt at £45 in small and £55 in XL belongs in
 * the sale; taking the maximum, or the first variant's price, would leave it
 * out and nobody would know why.
 */
import { createRuleEngine, type RuleFieldMeta } from '../../shared/rules/index.js'

export type {
  CompiledRules,
  RuleCondition,
  RuleFieldMeta,
  RuleFieldType,
  RuleSet,
} from '../../shared/rules/index.js'
export { parseRules } from '../../shared/rules/index.js'

/** Live variants of the product row `p`. Written once; used by four fields. */
const LIVE_VARIANTS = `SELECT 1 FROM product_variants v
                        WHERE v.product_id = p.id AND v.archived_at IS NULL`

export const PRODUCT_RULE_FIELDS: readonly RuleFieldMeta[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { key: 'title', label: 'Title', type: 'text', sql: 'p.title' },
  { key: 'handle', label: 'Handle', type: 'text', sql: 'p.handle::text' },
  { key: 'description', label: 'Description', type: 'text', sql: "coalesce(p.description, '')" },
  { key: 'vendor', label: 'Vendor', type: 'text', sql: "coalesce(p.vendor, '')" },
  { key: 'productType', label: 'Product type', type: 'text', sql: "coalesce(p.product_type, '')" },
  {
    key: 'tags',
    label: 'Tags',
    type: 'array',
    sql: 'p.tags',
    hint: 'Matches if the product carries the tag.',
  },
  {
    key: 'category',
    label: 'Category',
    type: 'text',
    sql: "coalesce((SELECT c.handle::text FROM categories c WHERE c.id = p.category_id), '')",
    hint: 'The category handle, not its name.',
  },

  // ── State ─────────────────────────────────────────────────────────────────
  {
    key: 'status',
    label: 'Status',
    type: 'enum',
    sql: 'p.status',
    options: ['draft', 'active', 'archived'],
  },
  {
    key: 'isPublished',
    label: 'Published',
    type: 'boolean',
    sql: 'EXISTS (SELECT 1 FROM product_publications pp WHERE pp.product_id = p.id)',
    hint: 'Visible on at least one sales channel.',
  },
  { key: 'createdAt', label: 'Created', type: 'date', sql: 'p.created_at' },
  { key: 'updatedAt', label: 'Last edited', type: 'date', sql: 'p.updated_at' },

  // ── Price ─────────────────────────────────────────────────────────────────
  {
    key: 'price',
    label: 'Price',
    type: 'money',
    sql: `(SELECT min(v.price_amount) FROM product_variants v
            WHERE v.product_id = p.id AND v.archived_at IS NULL AND v.is_active)`,
    hint: 'The cheapest live variant, in minor units — 5000 is £50.',
  },
  {
    key: 'compareAtPrice',
    label: 'Compare-at price',
    type: 'money',
    sql: `(SELECT max(v.compare_at_amount) FROM product_variants v
            WHERE v.product_id = p.id AND v.archived_at IS NULL)`,
    hint: 'In minor units.',
  },
  {
    key: 'discountPercent',
    label: 'Discount %',
    type: 'number',
    // "Is it reduced?" as a field of its own. The alternative is asking a
    // merchant to express it as a comparison between two other fields, which
    // the rule shape cannot do at all.
    sql: `(SELECT max(
             CASE WHEN v.compare_at_amount > 0
                  THEN round(((v.compare_at_amount - v.price_amount)::numeric
                              / v.compare_at_amount) * 100)
                  ELSE 0 END)
            FROM product_variants v
           WHERE v.product_id = p.id AND v.archived_at IS NULL)`,
    hint: 'How far below its compare-at price the deepest-discounted variant is.',
  },

  // ── Variants and stock ────────────────────────────────────────────────────
  {
    key: 'variantCount',
    label: 'Number of variants',
    type: 'number',
    sql: `(SELECT count(*) FROM product_variants v
            WHERE v.product_id = p.id AND v.archived_at IS NULL)`,
  },
  {
    key: 'sku',
    label: 'Any SKU',
    type: 'text',
    // Concatenated so one `contains` searches every variant's SKU without the
    // compiler needing an EXISTS form of its own.
    sql: `coalesce((SELECT string_agg(v.sku::text, ' ') FROM product_variants v
                     WHERE v.product_id = p.id AND v.archived_at IS NULL), '')`,
    hint: 'Matches against every variant SKU at once.',
  },
  {
    key: 'inventory',
    label: 'Stock on hand',
    type: 'number',
    // Sellable stock: what is on the shelf minus what is already committed to
    // orders that have not shipped. An untracked variant contributes nothing
    // here rather than pretending to be zero — see `isInStock` for the
    // question that treats it correctly.
    sql: `(SELECT coalesce(sum(l.available), 0)
             FROM product_variants v
             JOIN inventory_items i ON i.variant_id = v.id
             JOIN inventory_levels l ON l.inventory_item_id = i.id
            WHERE v.product_id = p.id AND v.archived_at IS NULL AND i.track_inventory)`,
    hint: 'Across every live variant and location, net of reservations.',
  },
  {
    key: 'isInStock',
    label: 'In stock',
    type: 'boolean',
    // Untracked stock is *available*, not zero: a made-to-order item is always
    // in stock. Folding that into the numeric field would make "stock is 0"
    // mean two different things.
    sql: `EXISTS (${LIVE_VARIANTS} AND v.is_active AND EXISTS (
            SELECT 1 FROM inventory_items i
             WHERE i.variant_id = v.id
               AND (NOT i.track_inventory OR EXISTS (
                     SELECT 1 FROM inventory_levels l
                      WHERE l.inventory_item_id = i.id AND l.available > 0))))`,
    hint: 'True if anything can be bought. Untracked items always count as in stock.',
  },
  {
    key: 'hasImage',
    label: 'Has an image',
    type: 'boolean',
    sql: 'EXISTS (SELECT 1 FROM product_media pm WHERE pm.product_id = p.id)',
  },
] as const

/**
 * Products compile against `products p`.
 *
 * The engine is shared with customer segments; only the vocabulary above and
 * the word for "no conditions" are ours.
 */
const engine = createRuleEngine(PRODUCT_RULE_FIELDS, { everything: 'Every product' })

export const compileRules = engine.compileRules
export const describeRules = engine.describeRules

/** The metadata the admin's rule builder is generated from. */
export const ruleFieldCatalogue = engine.catalogue
