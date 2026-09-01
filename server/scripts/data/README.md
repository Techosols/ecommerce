# Vendored data

## `shopify-taxonomy.json`

Levels 1–3 of the [Shopify Product Taxonomy][taxonomy], pinned to release
**v2026-05**, used by `npm run db:seed:categories`.

It is committed rather than fetched at seed time so that seeding works
offline, produces an identical tree on every machine, and shows up in a diff
when somebody upgrades it — a seed that quietly changes because an upstream
branch moved is a seed nobody can reproduce.

### Why only three levels

The published taxonomy is **14,606 categories, eight levels deep**. We ship
1,863 of them (1,792 after the default exclusions).

`GET /admin/categories` returns every category in one unpaginated array and the
admin assembles the tree client-side, so the depth is bounded by what that
screen can hold. Measured on the dev build at 1,793 categories: a 546 KB
response, first usable render ~3.2 s, ~70 ms per keystroke while searching.
Workable. The full 14,606 would be roughly 4 MB and eight times the DOM, and
would need the endpoint paginated and the tree made lazy first.

`taxonomy.service.ts` also caps the tree at `MAX_DEPTH = 5`, so a three-level
seed leaves a merchant two levels of their own to add underneath.

### Regenerating it

Pick the newest tag at <https://github.com/Shopify/product-taxonomy/tags>, then:

```bash
VERSION=v2026-05
curl -sL -o /tmp/categories.txt \
  "https://raw.githubusercontent.com/Shopify/product-taxonomy/$VERSION/dist/en/categories.txt"

python3 - "$VERSION" <<'PY'
import collections, json, sys

version = sys.argv[1].lstrip('v')
rows = []
with open('/tmp/categories.txt') as handle:
    for line in handle:
        if not line.startswith('gid://'):
            continue
        gid, path = line.rstrip('\n').split(' : ', 1)
        parts = [part.strip() for part in path.split(' > ')]
        if len(parts) > 3:          # levels 1-3 only; see above
            continue
        cid = gid.strip().split('/')[-1]
        rows.append((cid, cid.rsplit('-', 1)[0] if '-' in cid else None, parts[-1]))

position = collections.Counter()
categories = []
for cid, parent, name in rows:
    categories.append({'id': cid, 'parent': parent, 'name': name,
                       'position': position[parent or '']})
    position[parent or ''] += 1

json.dump({
    'source': 'Shopify Product Taxonomy',
    'version': version,
    'url': f'https://github.com/Shopify/product-taxonomy/blob/v{version}/dist/en/categories.txt',
    'retrievedAt': __import__('datetime').date.today().isoformat(),
    'maxDepth': 3,
    'note': 'Levels 1-3 of the published taxonomy, in source order. See scripts/data/README.md.',
    'categories': categories,
}, open('scripts/data/shopify-taxonomy.json', 'w'), ensure_ascii=False, indent=0)
print(len(categories), 'categories')
PY
```

Then run the tests — `tests/unit/taxonomy.seed.test.ts` asserts the version,
the node count and the vertical count, so an upgrade fails loudly and you
update the expectations deliberately rather than by accident.

Upgrading is additive by design: the seeder matches on name-under-parent and
only inserts what is missing, so re-running after a version bump adds the new
categories and leaves everything else alone. It does **not** rename or remove
categories Shopify has retired — that is a merchant's decision, not a seed's.

[taxonomy]: https://github.com/Shopify/product-taxonomy
