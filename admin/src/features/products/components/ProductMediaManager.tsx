import { useState } from 'react'
import { ArrowLeft, ArrowRight, ImageOff, Star, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/toast.context'
import { EmptyState } from '@/components/states/EmptyState'
import { ImageDropzone } from '@/features/media/ImageDropzone'
import { useImageUpload } from '@/features/media/media.hooks'
import { messageOf } from '@/lib/api/errors'
import { cn } from '@/lib/cn'
import {
  useAttachProductMedia,
  useDetachProductMedia,
  useReorderProductMedia,
} from '../hooks/products.hooks'
import type { ProductMedia } from '../types/products.types'

export interface ProductMediaManagerProps {
  productId: string
  media: ProductMedia[]
  canEdit: boolean
  disabled?: boolean
}

/**
 * The product's images.
 *
 * Follows the server's storage contract exactly and adds nothing to it: request
 * an upload, PUT the bytes at the URL the server chose, call `complete`, wait
 * for the worker to finish re-encoding, then attach the ready asset to the
 * product. The admin never picks a bucket, a key or a provider, and never talks
 * to a storage service the server did not point it at.
 *
 * Ordering is sent as a whole arrangement (`PUT .../media/order`) rather than as
 * a stream of moves, because the order *is* the content and reconstructing it
 * from individual swaps is how it drifts from what the merchandiser intended.
 * The ids in that call are product-media row ids, not asset ids.
 */
export function ProductMediaManager({
  productId,
  media,
  canEdit,
  disabled = false,
}: ProductMediaManagerProps) {
  const { toast } = useToast()
  const { upload, progress, reset } = useImageUpload()
  const attach = useAttachProductMedia(productId)
  const reorder = useReorderProductMedia(productId)
  const detach = useDetachProductMedia(productId)

  const [uploadErrors, setUploadErrors] = useState<string[]>([])
  const [removing, setRemoving] = useState<ProductMedia | null>(null)

  const busy = disabled || attach.isPending || reorder.isPending || detach.isPending
  const sorted = [...media].sort((a, b) => a.position - b.position)

  async function handleFiles(files: File[]) {
    setUploadErrors([])
    const failures: string[] = []

    // Sequential, not parallel: each upload ends in an attach that returns the
    // whole product, and running them at once would have several responses
    // racing to describe the same media list.
    for (const file of files) {
      try {
        const asset = await upload(file)
        await attach.mutateAsync({ mediaId: asset.id, alt: asset.alt })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') break
        failures.push(messageOf(error, `${file.name} could not be uploaded.`))
      }
    }

    reset()
    if (failures.length > 0) setUploadErrors(failures)
    else if (files.length > 0) {
      toast({
        tone: 'success',
        title: files.length === 1 ? 'Image added' : `${files.length} images added`,
      })
    }
  }

  function move(index: number, delta: number) {
    const next = [...sorted]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    reorder.mutate({ order: next.map((entry) => entry.id) })
  }

  function makePrimary(entry: ProductMedia) {
    reorder.mutate({ order: sorted.map((item) => item.id), primaryId: entry.id })
  }

  return (
    <Card>
      <CardHeader
        title="Media"
        description="The first image is the one customers see in listings."
      />
      <CardBody className="flex flex-col gap-4">
        {uploadErrors.length > 0 ? (
          <Alert
            tone="danger"
            title="Some images were not added"
            onDismiss={() => setUploadErrors([])}
          >
            <ul className="list-inside list-disc">
              {uploadErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {sorted.length === 0 && !canEdit ? (
          <EmptyState
            icon={<ImageOff className="size-5" />}
            title="No images"
            description="This product has no images yet."
          />
        ) : null}

        {sorted.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {sorted.map((entry, index) => (
              <li
                key={entry.id}
                className={cn(
                  'group bg-surface-sunken relative aspect-square overflow-hidden rounded-lg border',
                  entry.isPrimary ? 'border-brand-500 ring-brand-500/30 ring-2' : 'border-line',
                )}
              >
                {entry.url ? (
                  <img
                    src={entry.variants.medium ?? entry.url}
                    alt={entry.alt ?? ''}
                    loading="lazy"
                    className="size-full object-cover"
                  />
                ) : (
                  <div className="text-faint flex size-full flex-col items-center justify-center gap-1 text-xs">
                    <ImageOff className="size-5" />
                    Processing…
                  </div>
                )}

                {entry.isPrimary ? (
                  <span className="bg-brand-600 absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[0.625rem] font-semibold text-white">
                    Primary
                  </span>
                ) : null}

                {canEdit ? (
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-slate-950/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Tooltip label="Move left">
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        aria-label={`Move image ${index + 1} earlier`}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                        className="text-white hover:bg-white/20"
                      >
                        <ArrowLeft className="size-3.5" />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Make primary">
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        aria-label={`Make image ${index + 1} the primary image`}
                        disabled={busy || entry.isPrimary}
                        onClick={() => makePrimary(entry)}
                        className="text-white hover:bg-white/20"
                      >
                        <Star className="size-3.5" />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Move right">
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        aria-label={`Move image ${index + 1} later`}
                        disabled={busy || index === sorted.length - 1}
                        onClick={() => move(index, 1)}
                        className="text-white hover:bg-white/20"
                      >
                        <ArrowRight className="size-3.5" />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Remove">
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        aria-label={`Remove image ${index + 1}`}
                        disabled={busy}
                        onClick={() => setRemoving(entry)}
                        className="text-white hover:bg-white/20"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </Tooltip>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canEdit ? (
          <ImageDropzone
            onFiles={(files) => void handleFiles(files)}
            progress={progress}
            disabled={busy}
          />
        ) : null}
      </CardBody>

      <ConfirmDialog
        isOpen={removing !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return
          detach.mutate(removing.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: 'Image removed' })
              setRemoving(null)
            },
            onError: (error) =>
              toast({
                tone: 'error',
                title: 'Could not remove the image',
                description: messageOf(error),
              }),
          })
        }}
        title="Remove this image?"
        confirmLabel="Remove"
        tone="danger"
        isLoading={detach.isPending}
      >
        It is detached from this product. The uploaded file itself stays in the media library.
      </ConfirmDialog>
    </Card>
  )
}
