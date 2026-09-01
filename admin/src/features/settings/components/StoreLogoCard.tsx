import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { useToast } from '@/components/ui/toast.context'
import { ImageDropzone, useImageUpload } from '@/features/media'
import { messageOf } from '@/lib/api/errors'
import { useStoreSettings } from '../store.hooks'
import { useUpdateStoreSettings } from '../hooks/settings.hooks'

export interface StoreLogoCardProps {
  logoMediaId: string | null
  canWrite: boolean
}

/**
 * The shop's mark, on the storefront and at the top of every email.
 *
 * Saved on its own rather than with the rest of the page, and deliberately: the
 * other fields are text somebody is still typing, while a logo is finished the
 * moment it finishes uploading. Holding it behind the page's Save button would
 * mean an upload that appears to have worked and silently is not saved.
 *
 * The admin settings response carries `logoMediaId`; the *public* one carries
 * the resolved `logoUrl`. The preview reads the public one, because a media id
 * is not something a person can look at.
 */
export function StoreLogoCard({ logoMediaId, canWrite }: StoreLogoCardProps) {
  const { toast } = useToast()
  const publicSettings = useStoreSettings()
  const update = useUpdateStoreSettings()
  const { upload, progress } = useImageUpload()
  const [busy, setBusy] = useState(false)

  const logoUrl = publicSettings.data?.logoUrl ?? null

  async function onFiles(files: File[]) {
    const file = files[0]
    if (!file || busy) return

    setBusy(true)
    try {
      // Uploaded first, then pointed at: the server refuses a logo that has not
      // finished processing, so the id only exists once the bytes are real.
      const asset = await upload(file, { alt: 'Store logo' })
      await update.mutateAsync({ logoMediaId: asset.id })
      toast({ tone: 'success', title: 'Logo updated' })
    } catch (error) {
      toast({ tone: 'error', title: 'Could not set the logo', description: messageOf(error) })
    } finally {
      setBusy(false)
    }
  }

  function remove() {
    update.mutate(
      { logoMediaId: null },
      {
        onSuccess: () => toast({ tone: 'success', title: 'Logo removed' }),
        onError: (error) =>
          toast({ tone: 'error', title: 'Could not remove it', description: messageOf(error) }),
      },
    )
  }

  return (
    <Card>
      <CardHeader
        title="Logo"
        description="Shown on the storefront and at the top of every email."
        actions={
          canWrite && logoMediaId ? (
            <Button
              variant="ghost"
              size="sm"
              className="hover:text-danger"
              leadingIcon={<Trash2 className="size-3.5" />}
              isLoading={update.isPending}
              onClick={remove}
            >
              Remove
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-4">
        {logoUrl ? (
          <div className="border-line bg-surface-sunken flex items-center justify-center rounded-md border p-4">
            <img src={logoUrl} alt="The store logo" className="max-h-20 w-auto" />
          </div>
        ) : null}

        {canWrite ? (
          <ImageDropzone
            multiple={false}
            disabled={busy}
            progress={progress}
            onFiles={(files) => void onFiles(files)}
            hint="PNG or SVG on a transparent background reads best on both themes."
          />
        ) : logoUrl ? null : (
          <p className="text-muted text-sm">No logo set.</p>
        )}
      </CardBody>
    </Card>
  )
}
