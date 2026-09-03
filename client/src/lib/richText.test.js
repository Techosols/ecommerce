import { describe, expect, it } from 'vitest'
import { richTextToPlain } from './richText'

describe('richTextToPlain', () => {
  it('gives back the words', () => {
    expect(richTextToPlain('<p>What leaves the counter fastest.</p>')).toBe(
      'What leaves the counter fastest.',
    )
  })

  it('keeps a space where one block ends and the next begins', () => {
    // Without this, two paragraphs read as one word — "BalmRich" — which is
    // the whole reason a teaser cannot just drop the tags.
    expect(richTextToPlain('<p>Balm</p><p>Rich</p>')).toBe('Balm Rich')
  })

  it('flattens a list into a sentence rather than a run-on', () => {
    expect(richTextToPlain('<ul><li>Beeswax</li><li>Shea butter</li></ul>')).toBe(
      'Beeswax Shea butter',
    )
  })

  it('drops markup that has no text of its own', () => {
    expect(richTextToPlain('<p>Tin</p><img src="/lip.jpg" alt="">')).toBe('Tin')
  })

  it('collapses the whitespace the editor leaves behind', () => {
    expect(richTextToPlain('<p>  Unscented,\n  15 g  </p>')).toBe('Unscented, 15 g')
  })

  it('has nothing to say about nothing', () => {
    expect(richTextToPlain('')).toBe('')
    expect(richTextToPlain(null)).toBe('')
    expect(richTextToPlain(undefined)).toBe('')
  })
})
