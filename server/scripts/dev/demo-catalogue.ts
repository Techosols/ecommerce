/**
 * A catalogue to develop against.
 *
 *   npm run dev:catalogue      # ~30 products, published and stocked
 *
 * **Local development only.** These are invented products with invented prices,
 * and the script refuses to run unless `APP_ENV` is `local` — a storefront that
 * ships with a demo burger on it is worse than an empty one.
 *
 * Why it exists: a browsing UI cannot be built or verified against a store
 * holding two products. Filters that never filter, a pager that never pages and
 * a grid that never wraps all look fine until there is real breadth behind them.
 *
 * Additive and safe to re-run: a handle that already exists is skipped, so it
 * fills gaps and never touches a product somebody made by hand. Everything it
 * creates is tagged `demo`, which is how you find its work later.
 *
 * ── There is no `--reset` ────────────────────────────────────────────────────
 *
 * There was, and it could not be made honest. Stocking a variant writes to
 * `inventory_movements`, which is append-only by trigger — deleting from it is
 * refused, and rightly: it is the ledger that explains where stock went. A
 * product's handles are kept forever too, so a deleted product's address can
 * never be reissued.
 *
 * Both rules are load-bearing, and a convenience script is the last thing that
 * should be allowed to bypass them. To start from nothing, drop and re-create
 * the development database:
 *
 *   dropdb ecommerce && createdb ecommerce && npm run db:migrate && npm run db:seed
 */
import { closePool, initPool } from '../../src/infrastructure/database/pool.js'
import { query, queryOne } from '../../src/infrastructure/database/query.js'
import { createActor, type Actor } from '../../src/shared/auth/actor.js'
import { collectionsService, productsService } from '../../src/features/catalogue/index.js'
import { inventoryService } from '../../src/features/inventory/index.js'
import { env } from '../../src/config/index.js'

const DEMO_TAG = 'demo'

if (env.APP_ENV !== 'local') {
  console.error(`\nRefusing to run: APP_ENV is "${env.APP_ENV}". This script is for local development.\n`)
  process.exit(1)
}

interface Item {
  title: string
  subtitle: string
  description: string
  category: string
  productType: string
  tags: string[]
  /** Minor units. Integers, like every amount in this system. */
  price: number
  compareAt?: number
  /** Sizes become options and one variant each; omitted means a single variant. */
  sizes?: [string, number][]
  stock: number
}

/**
 * A small menu with deliberate variety.
 *
 * The awkward cases are the point: something out of stock, something with a
 * compare-at price, something with three sizes, something with a very long
 * title, and enough rows to page twice at a limit of twelve.
 */
const MENU: Item[] = [
  {
    title: 'Copperleaf Classic',
    subtitle: 'Two aged patties, house sauce, sesame brioche',
    description:
      'The one we opened with. Two thin patties pressed on a flat top so the edges catch, melted cheese, pickles, and the house sauce we will not tell you the recipe for. Served on a sesame brioche bun from the bakery two doors down.',
    category: 'Prepared Foods',
    productType: 'Burger',
    tags: ['beef', 'signature', 'bestseller'],
    price: 1150,
    sizes: [['Single', 0], ['Double', 250]],
    stock: 40,
  },
  {
    title: 'Smoked Brisket Burger',
    subtitle: 'Twelve-hour brisket, burnt-end mayo',
    description: 'Brisket smoked overnight over oak, chopped, and piled on a patty. Not a light lunch.',
    category: 'Prepared Foods',
    productType: 'Burger',
    tags: ['beef', 'smoked'],
    price: 1450,
    stock: 18,
  },
  {
    title: 'The Allotment',
    subtitle: 'Charred aubergine, whipped feta, dukkah',
    description: 'A vegetarian burger that is not an apology. Aubergine charred until it collapses.',
    category: 'Prepared Foods',
    productType: 'Burger',
    tags: ['vegetarian'],
    price: 1050,
    stock: 25,
  },
  {
    title: 'Buttermilk Chicken',
    subtitle: 'Overnight buttermilk, hot honey',
    description: 'Brined overnight, fried to order, finished with hot honey and a slaw that cuts through it.',
    category: 'Prepared Foods',
    productType: 'Burger',
    tags: ['chicken', 'bestseller'],
    price: 1250,
    sizes: [['Mild', 0], ['Hot', 0], ['Very hot', 0]],
    stock: 30,
  },
  {
    title: 'Margherita',
    subtitle: 'San Marzano, fior di latte, basil',
    description: 'Forty-eight hour dough, ninety seconds in the oven. Three ingredients with nowhere to hide.',
    category: 'Prepared Foods',
    productType: 'Pizza',
    tags: ['vegetarian', 'signature'],
    price: 1100,
    sizes: [['10 inch', 0], ['14 inch', 400]],
    stock: 35,
  },
  {
    title: "Nduja and Honey",
    subtitle: 'Spicy sausage, hot honey, ricotta',
    description: 'Nduja melts into the base and the honey stops it running away with itself.',
    category: 'Prepared Foods',
    productType: 'Pizza',
    tags: ['pork', 'spicy'],
    price: 1400,
    sizes: [['10 inch', 0], ['14 inch', 400]],
    stock: 22,
  },
  {
    title: 'Four Cheese and Black Pepper',
    subtitle: 'Fior di latte, gorgonzola, pecorino, taleggio',
    description: 'Cacio e pepe reasoning applied to a pizza. Cracked pepper on the way out of the oven.',
    category: 'Prepared Foods',
    productType: 'Pizza',
    tags: ['vegetarian'],
    price: 1350,
    stock: 0,
  },
  {
    title: 'Garlic and Rosemary Focaccia',
    subtitle: 'Torn, not sliced',
    description: 'Proved slowly, dimpled hard, salted heavily. Comes out warm or it does not come out.',
    category: 'Bakery',
    productType: 'Bread',
    tags: ['vegetarian', 'bakery'],
    price: 550,
    stock: 60,
  },
  {
    title: 'Sourdough Loaf',
    subtitle: 'Two-day ferment, dark crust',
    description: 'A proper crust. Keeps three days in paper and none at all in plastic.',
    category: 'Bakery',
    productType: 'Bread',
    tags: ['vegan', 'bakery'],
    price: 650,
    stock: 24,
  },
  {
    title: 'Cardamom Bun',
    subtitle: 'Laminated, ground to order',
    description: 'Cardamom ground the morning it is used, which is most of the reason it tastes like this.',
    category: 'Bakery',
    productType: 'Pastry',
    tags: ['vegetarian', 'bakery', 'bestseller'],
    price: 420,
    stock: 48,
  },
  {
    title: 'Almond Croissant',
    subtitle: "Yesterday's croissant, today's excuse",
    description: 'Frangipane, a second bake, and more icing sugar than is strictly defensible.',
    category: 'Bakery',
    productType: 'Pastry',
    tags: ['vegetarian', 'bakery'],
    price: 460,
    stock: 30,
  },
  {
    title: 'Salted Caramel Brownie',
    subtitle: 'Dense, not cakey',
    description: 'The argument about brownies is settled here in favour of dense.',
    category: 'Bakery',
    productType: 'Cake',
    tags: ['vegetarian'],
    price: 400,
    compareAt: 500,
    stock: 40,
  },
  {
    title: 'House Filter',
    subtitle: 'Rotating single origin, ground to order',
    description: 'Whatever is drinking best this month. Ask and somebody will tell you far too much about it.',
    category: 'Beverages',
    productType: 'Coffee',
    tags: ['coffee', 'vegan'],
    price: 320,
    sizes: [['Small', 0], ['Large', 70]],
    stock: 100,
  },
  {
    title: 'Flat White',
    subtitle: 'Double ristretto, steamed milk',
    description: 'Two shots, a short pour, no room for negotiation about the foam.',
    category: 'Beverages',
    productType: 'Coffee',
    tags: ['coffee', 'bestseller'],
    price: 380,
    stock: 100,
  },
  {
    title: 'Cold Brew',
    subtitle: 'Eighteen hours, no heat',
    description: 'Steeped cold overnight, which is why it tastes sweet without anything added.',
    category: 'Beverages',
    productType: 'Coffee',
    tags: ['coffee', 'vegan'],
    price: 420,
    sizes: [['Bottle', 0], ['Two bottles', 380]],
    stock: 36,
  },
  {
    title: 'Copperleaf Beans — Whole',
    subtitle: '250g, roasted weekly',
    description: 'Our own roast, bagged the day it is roasted. Grind it yourself or we will do it here.',
    category: 'Beverages',
    productType: 'Coffee beans',
    tags: ['coffee', 'vegan', 'retail'],
    price: 1200,
    sizes: [['250g', 0], ['1kg', 3400]],
    stock: 45,
  },
  {
    title: 'Loose Leaf Breakfast Tea',
    subtitle: 'Assam and Ceylon, 100g tin',
    description: 'Strong enough to stand a spoon in, which is the only correct strength.',
    category: 'Beverages',
    productType: 'Tea',
    tags: ['tea', 'vegan', 'retail'],
    price: 850,
    stock: 20,
  },
  {
    title: 'Elderflower Soda',
    subtitle: 'Pressed in Kent, lightly carbonated',
    description: 'Made forty miles away, and tastes it.',
    category: 'Beverages',
    productType: 'Soft drink',
    tags: ['vegan'],
    price: 350,
    stock: 72,
  },
  {
    title: 'Hand-Cut Chips',
    subtitle: 'Triple cooked, rosemary salt',
    description: 'Cooked three times because twice is not enough and four is showing off.',
    category: 'Prepared Foods',
    productType: 'Side',
    tags: ['vegan', 'bestseller'],
    price: 480,
    stock: 80,
  },
  {
    title: 'Charred Hispi Cabbage',
    subtitle: 'Black garlic butter, hazelnuts',
    description: 'A side that people order twice and then order instead of a main.',
    category: 'Prepared Foods',
    productType: 'Side',
    tags: ['vegetarian'],
    price: 620,
    stock: 26,
  },
  {
    title: 'House Pickles',
    subtitle: 'Cucumber, fennel seed, dill',
    description: 'Pickled here, in a jar, for a week. The brine is worth keeping.',
    category: 'Prepared Foods',
    productType: 'Side',
    tags: ['vegan'],
    price: 380,
    stock: 34,
  },
  {
    title: 'Copperleaf Hot Sauce',
    subtitle: 'Fermented scotch bonnet, 150ml',
    description: 'Fermented for a month. Hot, but the kind of hot you can taste past.',
    category: 'Condiments & Sauces',
    productType: 'Sauce',
    tags: ['vegan', 'retail', 'spicy'],
    price: 750,
    stock: 42,
  },
  {
    title: 'Burnt-End Mayo',
    subtitle: '200ml jar',
    description: 'The one from the brisket burger, in a jar, because people kept asking.',
    category: 'Condiments & Sauces',
    productType: 'Sauce',
    tags: ['retail'],
    price: 650,
    stock: 28,
  },
  {
    title: 'Smoked Chilli Oil',
    subtitle: '150ml, cold pressed',
    description: 'Good on everything here and most things that are not.',
    category: 'Condiments & Sauces',
    productType: 'Oil',
    tags: ['vegan', 'retail', 'spicy'],
    price: 900,
    compareAt: 1100,
    stock: 15,
  },
  {
    title: 'Sea Salt and Rosemary Butter',
    subtitle: 'Cultured, 125g',
    description: 'Cultured for two days before churning. Meant for the focaccia.',
    category: 'Condiments & Sauces',
    productType: 'Dairy',
    tags: ['vegetarian', 'retail'],
    price: 540,
    stock: 0,
  },
  {
    title: 'Copperleaf Tote',
    subtitle: 'Heavy cotton canvas, screen printed',
    description: 'Holds four loaves or one very optimistic grocery shop.',
    category: 'Tote Bags',
    productType: 'Bag',
    tags: ['merch', 'retail'],
    price: 1400,
    stock: 50,
  },
  {
    title: 'Enamel Mug',
    subtitle: '350ml, copper rim',
    description: 'Will chip. That is what enamel does, and it looks better for it.',
    category: 'Kitchen & Dining',
    productType: 'Drinkware',
    tags: ['merch', 'retail'],
    price: 1600,
    stock: 33,
  },
  {
    title: 'Apron',
    subtitle: 'Waxed canvas, brass hardware',
    description: 'The one the kitchen wears, which is the only endorsement worth having.',
    category: 'Protective Aprons',
    productType: 'Apparel',
    tags: ['merch', 'retail'],
    price: 4200,
    sizes: [['One size', 0]],
    stock: 12,
  },
  {
    title: 'Gift Card',
    subtitle: 'Any amount, no expiry',
    description: 'For the person who has opinions about their own coffee.',
    category: 'Kitchen & Dining',
    productType: 'Gift',
    tags: ['retail'],
    price: 2500,
    sizes: [['£25', 0], ['£50', 2500], ['£100', 7500]],
    stock: 999,
  },
  {
    title: 'Saturday Morning Bread and Pastry Box for Four People',
    subtitle: 'A deliberately long title, to see what a card does with it',
    description: 'One loaf, four pastries, a jar of butter. Ordered by Thursday, collected Saturday.',
    category: 'Bakery',
    productType: 'Box',
    tags: ['bakery', 'vegetarian'],
    price: 2800,
    stock: 8,
  },
]

async function categoryIdFor(name: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM categories WHERE lower(name) = lower($1) AND archived_at IS NULL
     ORDER BY parent_id NULLS FIRST LIMIT 1`,
    [name],
  )
  return row?.id ?? null
}

/**
 * The account this script acts as.
 *
 * Products are created through `productsService`, not with INSERTs, so the
 * invariants that service owns stay owned by it: the handle claim, the option
 * signature that makes a variant findable, the publication row, the audit
 * entry. Hand-written SQL here would be a second implementation of product
 * creation that nothing tests, and it would drift.
 */
async function demoActor(): Promise<Actor> {
  const owner = await queryOne<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.key = 'owner' ORDER BY u.created_at LIMIT 1`,
    [],
  )
  if (!owner) throw new Error('No owner account. Run `npm run db:seed` first.')

  const permissions = await query<{ key: string }>(`SELECT key FROM permissions`, [])

  return createActor({
    userId: owner.id,
    sessionId: 'demo-catalogue-script',
    email: owner.email,
    status: 'active',
    roles: ['owner'],
    permissions: new Set(permissions.map((row) => row.key)),
    emailVerified: true,
  })
}

/**
 * The collections a shopfront browses by.
 *
 * The storefront navigates by collection rather than by category, so a demo
 * catalogue without any is a shop with no way in. Two of these are smart —
 * their membership is a rule evaluated on every read, so they stay correct as
 * products come and go — and two are hand-picked lists.
 */
async function ensureCollections(actor: Actor): Promise<number> {
  const existing = new Set(
    (await query<{ handle: string }>(`SELECT handle FROM collections`, [])).map((row) => row.handle),
  )

  const wanted: {
    handle: string
    title: string
    description: string
    type: 'manual' | 'dynamic'
    rules?: { match: 'all' | 'any'; conditions: { field: string; operator: string; value: unknown }[] }
    tag?: string
  }[] = [
    {
      handle: 'bestsellers',
      title: 'Bestsellers',
      description: 'What leaves the counter fastest.',
      type: 'dynamic',
      rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'bestseller' }] },
    },
    {
      handle: 'in-the-bakery',
      title: 'In the bakery',
      description: 'Bread, pastry and everything proved overnight.',
      type: 'dynamic',
      rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'bakery' }] },
    },
    {
      handle: 'coffee-and-tea',
      title: 'Coffee and tea',
      description: 'Roasted on Tuesdays, ground to order.',
      type: 'dynamic',
      rules: { match: 'any', conditions: [
        { field: 'tags', operator: 'contains', value: 'coffee' },
        { field: 'tags', operator: 'contains', value: 'tea' },
      ] },
    },
    {
      handle: 'take-home',
      title: 'Take home',
      description: 'Jars, bags and things that keep.',
      type: 'dynamic',
      rules: { match: 'all', conditions: [{ field: 'tags', operator: 'contains', value: 'retail' }] },
    },
    {
      handle: 'under-10',
      title: 'Under 10',
      description: 'Everything at less than a tenner.',
      type: 'dynamic',
      // Minor units: a rule is closer to the data than a form is.
      rules: { match: 'all', conditions: [{ field: 'price', operator: 'lt', value: 1000 }] },
    },
  ]

  let made = 0
  for (const collection of wanted) {
    if (existing.has(collection.handle)) continue
    await collectionsService.create(
      {
        title: collection.title,
        handle: collection.handle,
        description: collection.description,
        type: collection.type,
        ...(collection.rules ? { rules: collection.rules } : {}),
      } as Parameters<typeof collectionsService.create>[0],
      actor,
    )
    made += 1
  }
  return made
}

async function main(): Promise<number> {
  initPool('cli')

  try {
    const actor = await demoActor()
    const existing = new Set(
      (await query<{ handle: string }>(`SELECT handle FROM products`, [])).map((row) => row.handle),
    )

    let made = 0
    let skipped = 0

    for (const item of MENU) {
      const handle = item.title
        .toLowerCase()
        .replace(/['\u2019]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')

      if (existing.has(handle)) {
        skipped += 1
        continue
      }

      const categoryId = await categoryIdFor(item.category)
      // A size that costs more says so in its own price, rather than in a
      // modifier the storefront would have to know how to apply.
      const sizes = item.sizes ?? [['Default', 0] as [string, number]]

      const product = await productsService.create(
        {
          title: item.title,
          handle,
          subtitle: item.subtitle,
          description: item.description,
          ...(categoryId ? { categoryId } : {}),
          productType: item.productType,
          tags: [...item.tags, DEMO_TAG],
          ...(item.sizes
            ? { options: [{ name: 'Size', values: item.sizes.map(([label]) => label) }] }
            : {}),
          variants: sizes.map(([label, surcharge], index) => ({
            title: label,
            sku: `${handle.slice(0, 20).toUpperCase()}-${index + 1}`,
            priceAmount: item.price + surcharge,
            ...(item.compareAt === undefined
              ? {}
              : { compareAtAmount: item.compareAt + surcharge }),
            weightGrams: 300,
            position: index,
            ...(item.sizes ? { options: { Size: label } } : {}),
          })),
        },
        actor,
      )

      // Created products are drafts. Activating is a separate decision from
      // publishing, and the service enforces the order — a draft cannot be
      // published, which is what stops a half-written product reaching a shop.
      await productsService.setStatus(product.id, 'active', actor)
      await productsService.publish(product.id, 'storefront', actor)

      // Stock, so availability is a real answer rather than "made to order".
      // Zero is left alone: `adjust` refuses a no-op, and an item with no
      // movement is exactly what an out-of-stock line should look like.
      if (item.stock > 0) {
        for (const variant of product.variants) {
          await inventoryService.adjust(
            { variantId: variant.id, delta: item.stock, reason: 'receive' },
            actor,
          )
        }
      }

      made += 1
    }

    const collections = await ensureCollections(actor)

    console.log(
      `\nCreated ${made} demo products${skipped > 0 ? `, skipped ${skipped} that already existed` : ''}.`,
    )
    if (collections > 0) console.log(`Created ${collections} collections.`)
    console.log('All tagged `demo`. Re-running is safe — existing handles are skipped.\n')
    return 0
  } catch (error) {
    console.error('\nDemo catalogue failed:', error instanceof Error ? error.message : error, '\n')
    if (error instanceof Error && error.cause) console.error(error.cause)
    return 1
  } finally {
    await closePool()
  }
}

process.exitCode = await main()
