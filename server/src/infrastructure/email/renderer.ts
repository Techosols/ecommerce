/**
 * Template rendering (§10.3).
 *
 *   props → Handlebars over the MJML fragment
 *         → inserted into _layout.mjml
 *         → MJML compiled to table-based HTML
 *         → plain-text alternative rendered from template.txt.hbs
 *
 * Handlebars runs before MJML so that `{{#if}}` blocks can include or exclude
 * whole MJML elements. Source files are read once and cached; rendering happens
 * in a worker, where the millisecond cost of an MJML compile is irrelevant.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Handlebars from 'handlebars'
import mjml2html from 'mjml'
import { createLogger } from '../logging/logger.js'
import { EMAIL_TEMPLATES, type TemplateName, type TemplateProps } from './templates/registry.js'

const log = createLogger('email.renderer')

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'templates')

export interface Branding {
  storeName: string
  supportEmail?: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

type Compiled = {
  body: HandlebarsTemplateDelegate
  text: HandlebarsTemplateDelegate
}

const sourceCache = new Map<TemplateName, Compiled>()
let layoutCache: HandlebarsTemplateDelegate | undefined

async function loadLayout(): Promise<HandlebarsTemplateDelegate> {
  if (layoutCache) return layoutCache
  const source = await readFile(path.join(TEMPLATES_DIR, '_layout.mjml'), 'utf8')
  layoutCache = Handlebars.compile(source, { noEscape: false })
  return layoutCache
}

async function loadTemplate(name: TemplateName): Promise<Compiled> {
  const cached = sourceCache.get(name)
  if (cached) return cached

  const dir = path.join(TEMPLATES_DIR, EMAIL_TEMPLATES[name].dir)
  const [bodySource, textSource] = await Promise.all([
    readFile(path.join(dir, 'template.mjml'), 'utf8'),
    readFile(path.join(dir, 'template.txt.hbs'), 'utf8'),
  ])

  const compiled: Compiled = {
    body: Handlebars.compile(bodySource),
    text: Handlebars.compile(textSource),
  }
  sourceCache.set(name, compiled)
  return compiled
}

export async function renderTemplate<T extends TemplateName>(
  name: T,
  props: TemplateProps<T>,
  branding: Branding,
): Promise<RenderedEmail> {
  const definition = EMAIL_TEMPLATES[name]
  const validated = definition.schema.parse(props) as TemplateProps<T>

  const [layout, template] = await Promise.all([loadLayout(), loadTemplate(name)])

  const subject = (definition.subject as (p: TemplateProps<T>) => string)(validated)
  const preview = definition.preview
    ? (definition.preview as (p: TemplateProps<T>) => string)(validated)
    : subject

  const bodyMjml = template.body(validated)
  const documentMjml = layout({
    body: bodyMjml,
    subject,
    preview,
    storeName: branding.storeName,
    supportEmail: branding.supportEmail,
  })

  const compiled = await mjml2html(documentMjml, { validationLevel: 'soft' })
  if (compiled.errors.length > 0) {
    log.warn(
      { template: name, errors: compiled.errors.map((e: { message: string }) => e.message) },
      'mjml warnings',
    )
  }

  return {
    subject,
    html: compiled.html,
    text: template.text(validated).trim(),
  }
}

/** Test helper — forces the next render to re-read from disk. */
export function clearTemplateCache(): void {
  sourceCache.clear()
  layoutCache = undefined
}
