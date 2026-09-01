import { useEffect } from 'react'
import { env } from '@/app/env'

/** Page title, so browser tabs and history are legible. */
export function useDocumentTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${env.appName}` : env.appName
  }, [title])
}
