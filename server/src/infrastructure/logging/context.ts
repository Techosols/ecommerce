/**
 * Ambient request/job context (§15.1).
 *
 * Carried through `AsyncLocalStorage` so that `requestId`, `userId` and `jobId`
 * appear on every log line without being threaded through function signatures.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
  requestId: string
  userId?: string
  jobId?: string
  queue?: string
  attempt?: number
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function getContext(): RequestContext | undefined {
  return storage.getStore()
}

/** Merge fields into the ambient context (e.g. `userId` once authentication ran). */
export function setContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore()
  if (current) Object.assign(current, patch)
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId
}
