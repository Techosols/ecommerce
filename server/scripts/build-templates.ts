/**
 * Copies email template sources into dist/.
 *
 * `tsc` only emits .ts, so the .mjml and .hbs files the renderer reads at
 * runtime have to be carried across explicitly.
 */
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

const from = path.resolve('src/infrastructure/email/templates')
const to = path.resolve('dist/infrastructure/email/templates')

await mkdir(to, { recursive: true })
await cp(from, to, {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
})

console.log(`Copied email templates → ${path.relative(process.cwd(), to)}`)
