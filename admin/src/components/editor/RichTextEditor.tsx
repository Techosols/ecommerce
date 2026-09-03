import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Textarea } from '@/components/ui/Textarea'
import { cn } from '@/lib/cn'
import { richTextExtensions } from './richTextExtensions'
import { RichTextToolbar } from './RichTextToolbar'
import { InsertImageDialog } from './InsertImageDialog'
import { InsertLinkDialog } from './InsertLinkDialog'
import { InsertVideoDialog } from './InsertVideoDialog'

export interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  disabled?: boolean
  placeholder?: string
  /** Roughly how tall before it scrolls. Descriptions vary a lot in length. */
  minHeight?: string
  'aria-label'?: string
  id?: string
}

/**
 * The rich text editor, in the shape Shopify's has.
 *
 * ── What is ours and what is not ─────────────────────────────────────────────
 *
 * The toolbar, the styling, the dialogs and the HTML view are written here.
 * ProseMirror underneath handles the parts that are genuinely hard and have
 * nothing to do with this shop: selection ranges across nested nodes, undo that
 * survives programmatic changes, paste from Word, and IME composition. A
 * document model also means this editor cannot emit broken HTML, which matters
 * because the server rejects what it cannot parse.
 *
 * ── HTML is the storage format ───────────────────────────────────────────────
 *
 * `value` in and `onChange` out are both HTML strings, so this drops into any
 * form that used a textarea and the database column does not change. The server
 * sanitises what arrives (`shared/validation/richText.ts`) — everything this
 * editor can produce survives that, and the two lists are maintained together.
 *
 * ── The source view ──────────────────────────────────────────────────────────
 *
 * Shopify's `<>` button, and the reason it exists: an editor can always be
 * asked for something it has no button for. Switching back re-parses the HTML
 * through the same document model, so anything the model cannot represent is
 * dropped *there*, visibly, rather than silently on save.
 */
export function RichTextEditor({
  value,
  onChange,
  disabled = false,
  placeholder = 'Write a description…',
  minHeight = '14rem',
  'aria-label': ariaLabel,
  id,
}: RichTextEditorProps) {
  const [isSource, setIsSource] = useState(false)
  const [source, setSource] = useState(value)
  const [linkOpen, setLinkOpen] = useState(false)
  const [imageOpen, setImageOpen] = useState(false)
  const [videoOpen, setVideoOpen] = useState(false)

  /**
   * Guards the round trip.
   *
   * Every keystroke fires `onChange`, the parent re-renders, and `value` comes
   * back as a prop. Without this the effect below would push that HTML into the
   * editor again mid-typing, which resets the caret to the start of the
   * document on every character.
   */
  const lastEmitted = useRef(value)

  /**
   * Which editor instance the content above was last pushed into.
   *
   * `useEditor` can hand back a *new* instance — StrictMode's double mount in
   * development does exactly this — and a new instance starts from the
   * `content` captured when the hook first ran, which for a form that loads its
   * data asynchronously is the empty string. The guard below is keyed on the
   * value, so it would see nothing to do and leave the fresh editor blank: a
   * product with a description would open with an empty box, and saving would
   * then wipe it.
   */
  const syncedEditor = useRef<unknown>(null)

  const editor = useEditor({
    extensions: richTextExtensions,
    content: value,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: 'rte-content focus:outline-none',
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        ...(id ? { id } : {}),
      },
    },
    onUpdate: ({ editor: instance }) => {
      // Empty is the empty string, not `<p></p>`. A form comparing its baseline
      // to decide whether it is dirty would otherwise think an untouched
      // description had changed the moment the editor mounted.
      const html = instance.isEmpty ? '' : instance.getHTML()

      /**
       * Nothing changed, so say nothing.
       *
       * ProseMirror emits an update as it initialises. Reporting that empty
       * document to the parent queues a `setValue('description', '')` which
       * React batches *after* the form's own `reset(product)` in the same
       * commit — so the description the page just loaded is overwritten with
       * the empty string, the editor stays blank, and the effect that would
       * have re-synced never fires because the value never changed.
       *
       * That failure is invisible: the field simply looks empty for a product
       * that has a description, and saving then writes the emptiness back.
       */
      if (html === lastEmitted.current) return

      lastEmitted.current = html
      onChange(html)
    },
  })

  // An outside change — a form reset, a different product loaded into the same
  // page — has to reach the editor. A change that came *from* the editor must
  // not.
  useEffect(() => {
    if (!editor || isSource) return

    // A different instance has to be filled whatever the value comparison says.
    const fresh = syncedEditor.current !== editor
    if (!fresh && value === lastEmitted.current) return

    syncedEditor.current = editor
    lastEmitted.current = value
    editor.commands.setContent(value || '', { emitUpdate: false })
  }, [editor, value, isSource])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  const toggleSource = useCallback(() => {
    if (!editor) return
    if (isSource) {
      // Back to the editor: re-parse, so anything the document model cannot
      // represent is dropped here, in front of the person who typed it.
      lastEmitted.current = source
      editor.commands.setContent(source || '', { emitUpdate: false })
      onChange(editor.isEmpty ? '' : editor.getHTML())
      setIsSource(false)
    } else {
      setSource(editor.isEmpty ? '' : editor.getHTML())
      setIsSource(true)
    }
  }, [editor, isSource, source, onChange])

  if (!editor) {
    // One frame before ProseMirror mounts. A box of the right height rather
    // than nothing, so the form does not jump.
    return (
      <div
        className="border-line bg-surface rounded-lg border"
        style={{ minHeight }}
        aria-busy="true"
      />
    )
  }

  return (
    <>
      <div
        className={cn(
          'border-line bg-surface overflow-hidden rounded-lg border',
          'focus-within:ring-brand-600 focus-within:border-brand-600 focus-within:ring-1',
          disabled && 'opacity-60',
        )}
      >
        <RichTextToolbar
          editor={editor}
          disabled={disabled}
          isSource={isSource}
          onToggleSource={toggleSource}
          onInsertLink={() => setLinkOpen(true)}
          onInsertImage={() => setImageOpen(true)}
          onInsertVideo={() => setVideoOpen(true)}
        />

        {isSource ? (
          <Textarea
            value={source}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setSource(event.target.value)}
            aria-label="HTML source"
            className="rte-source rounded-none border-0 focus:ring-0"
            style={{ minHeight }}
          />
        ) : (
          <div
            className="cursor-text px-3 py-2"
            style={{ minHeight }}
            // Clicking the padding around the text should put the caret in the
            // document, the way it does in any text box.
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) editor.commands.focus('end')
            }}
          >
            <EditorContent editor={editor} />
            {editor.isEmpty ? (
              <p className="text-faint pointer-events-none -mt-[1.6em] select-none">
                {placeholder}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* Mounted only while open. Three dialogs under every editor is three
          sets of hooks and a toast subscription for controls most descriptions
          never use — and it makes the editor usable outside a ToastProvider. */}
      {linkOpen ? (
        <InsertLinkDialog editor={editor} isOpen onClose={() => setLinkOpen(false)} />
      ) : null}
      {imageOpen ? (
        <InsertImageDialog editor={editor} isOpen onClose={() => setImageOpen(false)} />
      ) : null}
      {videoOpen ? (
        <InsertVideoDialog editor={editor} isOpen onClose={() => setVideoOpen(false)} />
      ) : null}
    </>
  )
}
