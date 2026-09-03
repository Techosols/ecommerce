import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'

export interface InsertLinkDialogProps {
  editor: Editor
  isOpen: boolean
  onClose: () => void
}

/** The schemes the server will keep. Anything else is stripped on save. */
const SAFE = /^(https?:\/\/|mailto:|tel:|\/)/i

/**
 * Adding or editing a link.
 *
 * Opens pre-filled when the caret is already inside one, so pressing the link
 * button on an existing link edits it rather than making a second one — which
 * is what Shopify does and what everybody expects.
 *
 * The scheme check here is a courtesy, not a control: it tells somebody their
 * `javascript:` link will not work *before* they save rather than after the
 * server silently drops it. The server remains the thing that decides.
 */
export function InsertLinkDialog({ editor, isOpen, onClose }: InsertLinkDialogProps) {
  const [href, setHref] = useState('')
  const [text, setText] = useState('')
  const [newTab, setNewTab] = useState(true)

  // Read the current link every time it opens, not once on mount.
  useEffect(() => {
    if (!isOpen) return
    const attrs = editor.getAttributes('link')
    const { from, to } = editor.state.selection
    setHref((attrs.href as string | undefined) ?? '')
    setText(editor.state.doc.textBetween(from, to, ' '))
    setNewTab((attrs.target as string | undefined) !== '_self')
  }, [isOpen, editor])

  const trimmed = href.trim()
  const invalid = trimmed.length > 0 && !SAFE.test(trimmed)
  const editing = editor.isActive('link')

  function apply() {
    if (!trimmed || invalid) return
    const chain = editor.chain().focus()
    const attrs = {
      href: trimmed,
      ...(newTab
        ? { target: '_blank', rel: 'noopener noreferrer nofollow' }
        : { target: '_self', rel: null }),
    }

    if (editor.state.selection.empty && text.trim()) {
      // No selection: insert the label the person typed, then link it.
      chain.insertContent({ type: 'text', text: text.trim(), marks: [{ type: 'link', attrs }] }).run()
    } else {
      chain.extendMarkRange('link').setLink(attrs).run()
    }
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit link' : 'Insert link'}
      size="sm"
      footer={
        <>
          {editing ? (
            <Button
              className="mr-auto"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run()
                onClose()
              }}
            >
              Remove link
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!trimmed || invalid} onClick={apply}>
            {editing ? 'Save' : 'Insert'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {editor.state.selection.empty ? (
          <Field label="Text">
            <Input
              value={text}
              autoFocus
              placeholder="Size guide"
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
        ) : null}

        <Field
          label="Link to"
          {...(invalid
            ? { error: 'Use a web address, an email address, or a path on this shop.' }
            : { hint: 'https://…, mailto:…, tel:… or /a-page-on-this-shop' })}
        >
          <Input
            value={href}
            autoFocus={!editor.state.selection.empty}
            placeholder="https://example.com"
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                apply()
              }
            }}
          />
        </Field>

        <Checkbox
          checked={newTab}
          label="Open in a new tab"
          onChange={(event) => setNewTab(event.target.checked)}
        />
      </div>
    </Modal>
  )
}
