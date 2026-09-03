import type { Editor } from '@tiptap/react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code,
  Image as ImageIcon,
  Indent,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Outdent,
  RemoveFormatting,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Video,
} from 'lucide-react'
import { DropdownItem, DropdownMenu } from '@/components/ui/DropdownMenu'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'

export interface RichTextToolbarProps {
  editor: Editor
  disabled?: boolean
  /** Toggles the HTML source view. */
  isSource: boolean
  onToggleSource: () => void
  onInsertLink: () => void
  onInsertImage: () => void
  onInsertVideo: () => void
}

/** Shopify's Formatting menu, exactly. */
const BLOCKS = [
  { id: 'paragraph', label: 'Paragraph' },
  { id: 'h1', label: 'Heading 1' },
  { id: 'h2', label: 'Heading 2' },
  { id: 'h3', label: 'Heading 3' },
  { id: 'h4', label: 'Heading 4' },
  { id: 'h5', label: 'Heading 5' },
  { id: 'h6', label: 'Heading 6' },
] as const

/**
 * The row of controls above the writing area.
 *
 * Grouped the way Shopify groups them, and in the same order, because the whole
 * point of matching is that somebody who has used Shopify reaches for a control
 * where their hand already expects it: block format, then the three character
 * marks, then lists, then alignment and indent, then the things that insert
 * something, then the escape hatches.
 *
 * Every button is an icon with a tooltip rather than a label. Fifteen labelled
 * controls is two rows on a laptop, and the toolbar would then be taller than
 * most of the descriptions written under it.
 *
 * `onMouseDown` with `preventDefault` on every button, not `onClick`: pressing
 * a toolbar button moves focus out of the editor and collapses the selection,
 * so "make this bold" would apply to nothing. This is the single most common
 * bug in hand-built toolbars.
 */
export function RichTextToolbar({
  editor,
  disabled = false,
  isSource,
  onToggleSource,
  onInsertLink,
  onInsertImage,
  onInsertVideo,
}: RichTextToolbarProps) {
  const currentBlock = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : editor.isActive('heading', { level: 4 })
          ? 'h4'
          : editor.isActive('heading', { level: 5 })
            ? 'h5'
            : editor.isActive('heading', { level: 6 })
              ? 'h6'
              : 'paragraph'

  function setBlock(id: string) {
    const chain = editor.chain().focus()
    if (id === 'paragraph') chain.setParagraph().run()
    else chain.toggleHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run()
  }

  // In source view everything but the source toggle is meaningless: the
  // commands act on a document the person is not currently looking at.
  const off = disabled || isSource

  return (
    <div className="border-line bg-surface-sunken flex flex-wrap items-center gap-0.5 rounded-t-lg border-b px-1.5 py-1">
      {/* ── Block format ─────────────────────────────────────────────────── */}
      <DropdownMenu
        align="start"
        trigger={(props) => (
          <button
            {...props}
            type="button"
            disabled={off}
            className={cn(
              'text-ink hover:bg-surface-hover flex h-7 items-center gap-1 rounded px-2 text-xs font-medium',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            {BLOCKS.find((block) => block.id === currentBlock)?.label ?? 'Paragraph'}
            <ChevronDown aria-hidden="true" className="size-3" />
          </button>
        )}
      >
        {BLOCKS.map((block) => (
          <DropdownItem key={block.id} onSelect={() => setBlock(block.id)}>
            <span className={block.id === currentBlock ? 'font-semibold' : undefined}>
              {block.label}
            </span>
          </DropdownItem>
        ))}
      </DropdownMenu>

      <Divider />

      {/* ── Character marks ──────────────────────────────────────────────── */}
      <Tool
        icon={Bold}
        label="Bold"
        shortcut="Ctrl+B"
        active={editor.isActive('bold')}
        disabled={off}
        onRun={() => editor.chain().focus().toggleBold().run()}
      />
      <Tool
        icon={Italic}
        label="Italic"
        shortcut="Ctrl+I"
        active={editor.isActive('italic')}
        disabled={off}
        onRun={() => editor.chain().focus().toggleItalic().run()}
      />
      <Tool
        icon={UnderlineIcon}
        label="Underline"
        shortcut="Ctrl+U"
        active={editor.isActive('underline')}
        disabled={off}
        onRun={() => editor.chain().focus().toggleUnderline().run()}
      />

      <Divider />

      {/* ── Lists ────────────────────────────────────────────────────────── */}
      <Tool
        icon={List}
        label="Bulleted list"
        active={editor.isActive('bulletList')}
        disabled={off}
        onRun={() => editor.chain().focus().toggleBulletList().run()}
      />
      <Tool
        icon={ListOrdered}
        label="Numbered list"
        active={editor.isActive('orderedList')}
        disabled={off}
        onRun={() => editor.chain().focus().toggleOrderedList().run()}
      />

      <Divider />

      {/* ── Alignment ────────────────────────────────────────────────────── */}
      <Tool
        icon={AlignLeft}
        label="Align left"
        active={editor.isActive({ textAlign: 'left' })}
        disabled={off}
        onRun={() => editor.chain().focus().setTextAlign('left').run()}
      />
      <Tool
        icon={AlignCenter}
        label="Align centre"
        active={editor.isActive({ textAlign: 'center' })}
        disabled={off}
        onRun={() => editor.chain().focus().setTextAlign('center').run()}
      />
      <Tool
        icon={AlignRight}
        label="Align right"
        active={editor.isActive({ textAlign: 'right' })}
        disabled={off}
        onRun={() => editor.chain().focus().setTextAlign('right').run()}
      />
      <Tool
        icon={AlignJustify}
        label="Justify"
        active={editor.isActive({ textAlign: 'justify' })}
        disabled={off}
        onRun={() => editor.chain().focus().setTextAlign('justify').run()}
      />

      <Divider />

      {/* ── Indent ───────────────────────────────────────────────────────── */}
      {/* Indent only means anything inside a list, which is what Shopify's
          does too — it nests the item rather than adding whitespace. */}
      <Tool
        icon={Outdent}
        label="Outdent"
        disabled={off || !editor.can().liftListItem('listItem')}
        onRun={() => editor.chain().focus().liftListItem('listItem').run()}
      />
      <Tool
        icon={Indent}
        label="Indent"
        disabled={off || !editor.can().sinkListItem('listItem')}
        onRun={() => editor.chain().focus().sinkListItem('listItem').run()}
      />

      <Divider />

      {/* ── Insert ───────────────────────────────────────────────────────── */}
      <Tool
        icon={LinkIcon}
        label="Insert link"
        shortcut="Ctrl+K"
        active={editor.isActive('link')}
        disabled={off}
        onRun={onInsertLink}
      />
      <Tool icon={ImageIcon} label="Insert image" disabled={off} onRun={onInsertImage} />
      <Tool icon={Video} label="Insert video" disabled={off} onRun={onInsertVideo} />
      <Tool
        icon={TableIcon}
        label="Insert table"
        disabled={off}
        onRun={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      />

      <Divider />

      {/* ── Escape hatches ───────────────────────────────────────────────── */}
      <Tool
        icon={RemoveFormatting}
        label="Clear formatting"
        disabled={off}
        onRun={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      />
      <Tool
        icon={Code}
        label={isSource ? 'Back to the editor' : 'Edit HTML'}
        active={isSource}
        disabled={disabled}
        onRun={onToggleSource}
      />
    </div>
  )
}

function Divider() {
  return <span aria-hidden="true" className="bg-line mx-1 h-5 w-px" />
}

interface ToolProps {
  icon: typeof Bold
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onRun: () => void
}

function Tool({ icon: Icon, label, shortcut, active = false, disabled = false, onRun }: ToolProps) {
  return (
    <Tooltip label={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        // The whole reason this is `onMouseDown` and not `onClick`: a click
        // first blurs the editor, and a blurred editor has no selection to
        // format. Preventing the default keeps the caret where it was.
        onMouseDown={(event) => {
          event.preventDefault()
          if (!disabled) onRun()
        }}
        className={cn(
          'flex size-7 items-center justify-center rounded transition-colors',
          active ? 'bg-ink text-white' : 'text-ink-soft hover:bg-surface-hover hover:text-ink',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    </Tooltip>
  )
}
