import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RichTextEditor } from './RichTextEditor'

/**
 * The rich text editor.
 *
 * Two behaviours carry real risk and are what this suite exists for:
 *
 *   **Content that arrives late must reach the editor.** Every form here loads
 *   its data asynchronously, so the editor mounts empty and the description
 *   turns up a moment later. If that never lands, the merchant sees a blank box
 *   for a product that has a description — and saving then wipes it.
 *
 *   **Typing must not fight the round trip.** `onChange` goes to the parent and
 *   comes back as `value`; pushing that back into the editor mid-keystroke
 *   moves the caret to the start of the document.
 */

afterEach(cleanup)

/** A controlled parent, the way every real form here uses it. */
function Controlled({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return <RichTextEditor value={value} onChange={setValue} aria-label="Description" />
}

/** A parent that behaves like the real forms: empty first, data later. */
function LateLoader({ eventual }: { eventual: string }) {
  const [value, setValue] = useState('')
  return (
    <div>
      <button type="button" onClick={() => setValue(eventual)}>
        Load
      </button>
      <RichTextEditor value={value} onChange={setValue} aria-label="Description" />
    </div>
  )
}

describe('content arriving after mount', () => {
  it('shows a description that loads a moment after the editor', async () => {
    // The exact shape of the bug this guards: the editor mounts with '' while
    // the query is still in flight, and the value appears afterwards.
    render(<LateLoader eventual="<p>Made by hand</p>" />)

    await screen.findByLabelText('Description')
    await userEvent.click(screen.getByRole('button', { name: 'Load' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Description')).toHaveTextContent('Made by hand')
    })
  })

  it('renders headings and lists as structure, not as text', async () => {
    render(<LateLoader eventual="<h2>Care</h2><ul><li>Keep cool</li></ul>" />)
    await screen.findByLabelText('Description')
    await userEvent.click(screen.getByRole('button', { name: 'Load' }))

    await waitFor(() => {
      const area = screen.getByLabelText('Description')
      expect(area.querySelector('h2')).toHaveTextContent('Care')
      expect(area.querySelector('li')).toHaveTextContent('Keep cool')
    })
  })
})

/**
 * Typing itself is covered by the browser drive, not here.
 *
 * ProseMirror needs real Range and Selection APIs to place a caret in a
 * contenteditable, and jsdom implements neither well enough — `userEvent`
 * typing into the editor throws inside prosemirror-view rather than producing
 * text. Asserting on it here would mean asserting on a fiction.
 */

describe('the toolbar', () => {
  it('offers the controls Shopify offers', async () => {
    render(<RichTextEditor value="" onChange={vi.fn()} aria-label="Description" />)
    await screen.findByLabelText('Description')

    for (const label of [
      'Bold',
      'Italic',
      'Underline',
      'Bulleted list',
      'Numbered list',
      'Align left',
      'Align centre',
      'Align right',
      'Justify',
      'Outdent',
      'Indent',
      'Insert link',
      'Insert image',
      'Insert video',
      'Insert table',
      'Clear formatting',
      'Edit HTML',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument()
    }
  })

  it('shows the HTML behind the document, and takes it back', async () => {
    // Controlled, because the component is: with a mock `onChange` the parent
    // never accepts the edit and the editor correctly reverts to its prop.
    render(<Controlled initial="<p>Hello</p>" />)
    await screen.findByLabelText('Description')

    await userEvent.click(screen.getByRole('button', { name: /Edit HTML/i }))
    const source = await screen.findByLabelText('HTML source')
    expect(source).toHaveValue('<p>Hello</p>')

    await userEvent.clear(source)
    await userEvent.type(source, '<p>Edited</p>')
    await userEvent.click(screen.getByRole('button', { name: /Back to the editor/i }))

    await waitFor(() => {
      expect(screen.getByLabelText('Description')).toHaveTextContent('Edited')
    })
  })

  it('reports whether a mark is on', async () => {
    render(<RichTextEditor value="" onChange={vi.fn()} aria-label="Description" />)
    await screen.findByLabelText('Description')
    // Pressed state is what tells somebody the button is a toggle rather than
    // an action, and it is the part a screen reader announces.
    expect(screen.getByRole('button', { name: /Bold/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
