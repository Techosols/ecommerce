import { NotFoundState } from '@/components/states/AccessStates'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

export function NotFoundPage() {
  useDocumentTitle('Page not found')
  return <NotFoundState />
}
