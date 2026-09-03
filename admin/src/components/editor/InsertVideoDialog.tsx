import { useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'

export interface InsertVideoDialogProps {
  editor: Editor
  isOpen: boolean
  onClose: () => void
}

/**
 * The hosts the server will actually frame.
 *
 * Kept in step with `allowedIframeHostnames` on the server. Telling somebody
 * here that a Facebook video will not work is a second's disappointment;
 * letting them save it and finding an empty box on the storefront next week is
 * a support ticket.
 */
const ACCEPTED = /(?:youtube\.com|youtu\.be|vimeo\.com)/i

export function InsertVideoDialog({ editor, isOpen, onClose }: InsertVideoDialogProps) {
  const [url, setUrl] = useState('')

  const trimmed = url.trim()
  const ok = trimmed.length > 0 && ACCEPTED.test(trimmed)
  const wrongHost = trimmed.length > 8 && !ok

  function insert() {
    if (!ok) return
    // TipTap parses the many YouTube URL shapes — watch?v=, youtu.be/, embed/ —
    // and emits the embed form. Vimeo it passes through, and the server's host
    // allowlist is what decides whether it survives.
    editor.commands.setYoutubeVideo({ src: trimmed, width: 640, height: 360 })
    setUrl('')
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        setUrl('')
        onClose()
      }}
      title="Insert video"
      description="Paste a link to the video. It plays inline on the product page."
      size="sm"
      footer={
        <>
          <Button
            onClick={() => {
              setUrl('')
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={insert}>
            Insert
          </Button>
        </>
      }
    >
      <Field
        label="Video link"
        {...(wrongHost
          ? { error: 'Only YouTube and Vimeo can be embedded. Other hosts are removed when you save.' }
          : { hint: 'A YouTube or Vimeo address.' })}
      >
        <Input
          value={url}
          autoFocus
          placeholder="https://www.youtube.com/watch?v=…"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ok) {
              event.preventDefault()
              insert()
            }
          }}
        />
      </Field>
    </Modal>
  )
}
