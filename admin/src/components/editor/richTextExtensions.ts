import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import Youtube from '@tiptap/extension-youtube'
import StarterKit from '@tiptap/starter-kit'

/**
 * The document this editor can produce, and nothing wider.
 *
 * Every extension here has a matching entry in the server's allowlist
 * (`shared/validation/richText.ts`). That pairing is the whole contract: the
 * editor is what a person can *type*, the allowlist is what the shop will
 * *store*, and they are kept deliberately identical so that nothing a merchant
 * writes is silently thrown away on save.
 *
 * If you add an extension here, add the tag there in the same commit. A mark
 * the editor emits and the server strips looks exactly like a bug that ate
 * somebody's work.
 */
export const richTextExtensions = [
  StarterKit.configure({
    // Six levels, like Shopify's Formatting menu.
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // `<code>` and `<pre>` stay: a shop selling anything technical needs them,
    // and both are in the allowlist.
    codeBlock: { HTMLAttributes: { class: 'rte-code' } },
    link: false,
    underline: false,
  }),

  Underline,

  /**
   * Links, with the safety attributes baked in.
   *
   * `openOnClick: false` because inside an editor a click means "put my cursor
   * here", not "leave the page I am writing". The `rel` is set here as well as
   * on the server — the server's copy is the one that counts, this one just
   * means the editor's own HTML already matches what will come back.
   */
  Link.configure({
    openOnClick: false,
    autolink: true,
    protocols: ['http', 'https', 'mailto', 'tel'],
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
  }),

  /**
   * Alignment as a class, not as inline CSS.
   *
   * The server strips `style` from every element — arbitrary CSS in a
   * description is an invisible overlay across the storefront — so alignment
   * has to survive as something the allowlist keeps.
   */
  TextAlign.extend({
    addGlobalAttributes() {
      return [
        {
          types: this.options.types as string[],
          attributes: {
            textAlign: {
              default: null,
              parseHTML: (element: HTMLElement) => {
                const cls = element.getAttribute('class') ?? ''
                const match = /\brte-align-(left|center|right|justify)\b/.exec(cls)
                return match?.[1] ?? null
              },
              renderHTML: (attributes: Record<string, unknown>) =>
                attributes.textAlign ? { class: `rte-align-${String(attributes.textAlign)}` } : {},
            },
          },
        },
      ]
    },
  }).configure({
    types: ['heading', 'paragraph'],
    alignments: ['left', 'center', 'right', 'justify'],
  }),

  Image.configure({ inline: false, allowBase64: false }),

  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,

  /**
   * Video, as an embed rather than a file.
   *
   * `nocookie` because a product page should not set a tracking cookie on a
   * shopper who never pressed play. The server only frames these two hosts, so
   * anything else pasted in is stripped on save rather than quietly kept.
   */
  Youtube.configure({
    nocookie: true,
    controls: true,
    modestBranding: true,
    HTMLAttributes: { class: 'rte-embed' },
  }),
]
