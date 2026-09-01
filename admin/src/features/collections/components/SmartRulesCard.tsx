import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { useToast } from '@/components/ui/toast.context'
import { QueryBoundary } from '@/components/states/QueryBoundary'
import { RuleBuilder, completeRules, type RuleSet } from '@/components/rules'
import { messageOf } from '@/lib/api/errors'
import { formatNumber } from '@/lib/format'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
  useCollectionRuleFields,
  usePreviewCollection,
  useUpdateCollection,
} from '../hooks/collections.hooks'

export interface SmartRulesCardProps {
  collectionId: string
  rules: RuleSet
  canWrite: boolean
}

/**
 * The rules, with the answer beside them.
 *
 * The preview is the point. Rules are easy to write and easy to get subtly
 * wrong — `price` is the *cheapest* variant, `tags` matches one of several —
 * and a count with a few real product names is the only thing that tells a
 * merchant whether the rules mean what they think before the collection goes
 * live on the storefront.
 *
 * Every field and operator offered comes from the server's catalogue, so the
 * builder cannot compose a rule the compiler will refuse.
 */
export function SmartRulesCard({ collectionId, rules, canWrite }: SmartRulesCardProps) {
  const { toast } = useToast()
  const fields = useCollectionRuleFields()
  const preview = usePreviewCollection()
  const save = useUpdateCollection(collectionId)

  const [draft, setDraft] = useState<RuleSet>(rules)
  const isDirty = JSON.stringify(draft) !== JSON.stringify(rules)

  const [baseline, setBaseline] = useState(rules)
  if (JSON.stringify(baseline) !== JSON.stringify(rules)) {
    setBaseline(rules)
    if (!isDirty) setDraft(rules)
  }

  // Settled rules, not every keystroke: the preview is a query per change.
  const settled = useDebouncedValue(JSON.stringify(completeRules(draft)), 500)
  useEffect(() => {
    preview.mutate(JSON.parse(settled) as RuleSet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="text-brand-600 size-4" />
            Rules
          </span>
        }
        description="Checked against the catalogue every time the collection is read, so it is never out of date."
      />

      <CardBody className="flex flex-col gap-5">
        <QueryBoundary
          isLoading={fields.isPending}
          error={fields.error}
          onRetry={() => void fields.refetch()}
        >
          <RuleBuilder
            value={draft}
            onChange={setDraft}
            fields={fields.data ?? []}
            disabled={!canWrite}
            subject="Products"
          />
        </QueryBoundary>

        <div className="border-line bg-surface-subtle rounded-md border p-3">
          <p className="text-muted mb-1 text-xs font-medium">
            {isDirty ? 'These rules would match' : 'Matching now'}
          </p>

          {preview.isPending ? (
            <p className="text-muted text-sm">Counting…</p>
          ) : preview.error ? (
            <p className="text-danger text-sm">{messageOf(preview.error)}</p>
          ) : preview.data ? (
            <>
              <p className="text-ink tabular text-2xl font-semibold">
                {formatNumber(preview.data.productCount)}
                <span className="text-muted ml-1.5 text-sm font-normal">
                  {preview.data.productCount === 1 ? 'product' : 'products'}
                </span>
              </p>
              <p className="text-muted mt-0.5 text-xs">{preview.data.summary}</p>

              {preview.data.products.length > 0 ? (
                <ul className="text-ink-soft mt-2 flex flex-col gap-0.5 text-sm">
                  {preview.data.products.slice(0, 6).map((product) => (
                    <li key={product.id} className="truncate">
                      <Link to={`/products/${product.id}`} className="hover:text-brand-600">
                        {product.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      </CardBody>

      {canWrite && isDirty ? (
        <CardFooter className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(rules)}>
            Discard
          </Button>
          <Button
            isLoading={save.isPending}
            onClick={() =>
              save.mutate(
                { rules: completeRules(draft) },
                {
                  onSuccess: () => toast({ tone: 'success', title: 'Rules saved' }),
                  onError: (error) =>
                    toast({
                      tone: 'error',
                      title: 'Could not save the rules',
                      description: messageOf(error),
                    }),
                },
              )
            }
          >
            Save rules
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}
