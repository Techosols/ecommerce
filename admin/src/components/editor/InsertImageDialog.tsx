import { useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Tabs } from '@/components/ui/Tabs'
import { useToast } from '@/components/ui/toast.context'
import { ImageDropzone } from '@/features/media/ImageDropzone'
import { useImageUpload } from '@/features/media/media.hooks'
import { messageOf } from '@/lib/api/errors'

export interface InsertImageDialogProps {
  editor: Editor
  isOpen: boolean
  onClose: () => void
}

/**
 * Putting a picture in a description.
 *
 * Two ways in, because both are real: upload something from the desk, or paste
 * a URL for an image already hosted somewhere. Uploading goes through the
 * shop's existing three-step media pipeline — the same one product images use —
 * so a description image is a real asset with a real record rather than a hot
 * link to whatever the merchant happened to have open.
 *
 * **Alt text is asked for every time and is not optional-looking.** A product
 * description full of unlabelled images is unreadable to anybody using a screen
 * reader and invisible to search. It is one field; the cost of asking is a
 * second, and the cost of not asking is permanent.
 */
export function InsertImageDialog({ editor, isOpen, onClose }: InsertImageDialogProps) {
  const { toast } = useToast()
  const { upload, progress } = useImageUpload()
  const [tab, setTab] = useState<'upload' | 'url'>('upload')
  const [url, setUrl] = useState('')
  const [alt, setAlt] = useState('')

  function reset() {
    setUrl('')
    setAlt('')
    setTab('upload')
  }

  function insert(src: string) {
    editor.chain().focus().setImage({ src, alt: alt.trim() || '' }).run()
    reset()
    onClose()
  }

  async function onFiles(files: File[]) {
    const file = files[0]
    if (!file) return
    try {
      const asset = await upload(file, ...(alt.trim() ? [{ alt: alt.trim() }] : []))
      if (!asset.url) {
        toast({ tone: 'error', title: 'That image has no address yet', description: 'Try again in a moment.' })
        return
      }
      insert(asset.url)
    } catch (error) {
      toast({ tone: 'error', title: 'Upload failed', description: messageOf(error) })
    }
  }

  const httpUrl = /^https?:\/\//i.test(url.trim())

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Insert image"
      size="md"
      footer={
        <>
          <Button
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          {tab === 'url' ? (
            <Button variant="primary" disabled={!httpUrl} onClick={() => insert(url.trim())}>
              Insert
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Tabs
          items={[
            { id: 'upload', label: 'Upload' },
            { id: 'url', label: 'From a URL' },
          ]}
          value={tab}
          onChange={(next) => setTab(next as 'upload' | 'url')}
        />

        {/* Above the source, because it applies to both and because asking for
            it after the upload has already inserted the image is asking for it
            too late. */}
        <Field
          label="Alt text"
          hint="What the picture shows, for anyone who cannot see it. Search engines read this too."
        >
          <Input
            value={alt}
            placeholder="A jar of lip balm beside dried roses"
            onChange={(event) => setAlt(event.target.value)}
          />
        </Field>

        {tab === 'upload' ? (
          <ImageDropzone
            onFiles={onFiles}
            progress={progress}
            hint="It joins your media library, like a product image."
          />
        ) : (
          <Field label="Image address" hint="Must start with https://">
            <Input
              value={url}
              autoFocus
              placeholder="https://example.com/photo.jpg"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && httpUrl) {
                  event.preventDefault()
                  insert(url.trim())
                }
              }}
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}
