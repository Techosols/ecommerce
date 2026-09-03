import { useCallback, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { messageOf } from '@/lib/api'
import { bankTransferApi, putBytes, validateReceipt } from '../api/bankTransfer.api'

export const bankTransferKey = (claim) => [
  'bank-transfer',
  claim?.orderNumber ?? null,
  claim?.email ?? null,
]

/**
 * Looking up an order to pay for.
 *
 * A mutation rather than a query, because the credential is typed into a form
 * and submitting it is the action. Also because it is a POST: an email address
 * in a URL ends up in browser history, access logs and the `Referer` header of
 * every asset the page then loads.
 */
export function useBankTransferDetails() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (claim) => bankTransferApi.details(claim),
    onSuccess: (data, claim) => queryClient.setQueryData(bankTransferKey(claim), data),
  })
}

const POLL_INTERVAL_MS = 1000
const PROCESSING_TIMEOUT_MS = 60_000

/**
 * The whole receipt submission, as one thing the page can call.
 *
 * Four network steps with a poll in the middle is not something a component
 * should be assembling inline, and the phases are what the person watching
 * actually cares about — "uploading" and "checking the image" are different
 * waits and deserve different words.
 *
 * Cancellable throughout: an upload on mobile data is long enough that somebody
 * will change their mind, and an abandoned request that later resolves would
 * otherwise submit a proof for a page nobody is looking at any more.
 */
export function useSubmitReceipt() {
  const [phase, setPhase] = useState('idle')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase('idle')
    setPercent(0)
  }, [])

  const reset = useCallback(() => {
    setPhase('idle')
    setPercent(0)
    setError(null)
  }, [])

  const submit = useCallback(async (claim, file, claimFields) => {
    const localError = validateReceipt(file)
    if (localError) {
      setError(localError)
      setPhase('failed')
      throw new Error(localError)
    }

    const controller = new AbortController()
    abortRef.current = controller
    setError(null)

    try {
      setPhase('requesting')
      setPercent(0)
      const ticket = await bankTransferApi.requestUpload(claim, file)

      setPhase('uploading')
      await putBytes(ticket, file, setPercent, controller.signal)

      setPhase('processing')
      setPercent(100)
      await bankTransferApi.completeUpload(claim, ticket.assetId)

      /**
       * Waiting for the image to be resized.
       *
       * The submit below refuses anything not `ready`, and processing happens
       * in a background job — so this asks rather than guessing. The deadline
       * exists because a stalled worker must eventually produce a sentence a
       * person can act on rather than a spinner that never stops.
       */
      const deadline = Date.now() + PROCESSING_TIMEOUT_MS
      let status = await bankTransferApi.uploadStatus(claim, ticket.assetId)
      while (status.status !== 'ready' && status.status !== 'failed') {
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        if (Date.now() > deadline) {
          throw new Error(
            'The image is taking longer than usual to process. Nothing is lost — try sending it again in a minute.',
          )
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        status = await bankTransferApi.uploadStatus(claim, ticket.assetId)
      }

      if (status.status === 'failed') {
        // The server's own words ("file content is not a recognised image")
        // beat anything this page could invent from a status alone.
        throw new Error(status.failureReason ?? 'That image could not be read. Try another one.')
      }

      setPhase('submitting')
      const proof = await bankTransferApi.submitProof(claim, {
        mediaId: ticket.assetId,
        ...claimFields,
      })

      setPhase('done')
      return proof
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        setPhase('idle')
        setPercent(0)
        throw caught
      }
      setError(messageOf(caught))
      setPhase('failed')
      throw caught
    } finally {
      abortRef.current = null
    }
  }, [])

  return { submit, cancel, reset, phase, percent, error, isBusy: BUSY.has(phase) }
}

const BUSY = new Set(['requesting', 'uploading', 'processing', 'submitting'])
