import { Radio, RefreshCw, WifiOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { useConnectionState } from '@/lib/realtime/useRealtimeEvent'

const presentation = {
  idle: { label: 'Realtime off', icon: WifiOff, className: 'text-faint' },
  connecting: { label: 'Connecting…', icon: RefreshCw, className: 'text-muted animate-spin' },
  connected: { label: 'Live', icon: Radio, className: 'text-positive' },
  reconnecting: { label: 'Reconnecting…', icon: RefreshCw, className: 'text-warning animate-spin' },
  failed: { label: 'Realtime unavailable', icon: WifiOff, className: 'text-danger' },
} as const

/**
 * Whether the dashboard is live.
 *
 * Worth a permanent place in the header because realtime is best-effort: when
 * it is down, pages still work but stop updating themselves, and an operator
 * watching a stale order queue should be able to see that rather than infer it.
 */
export function ConnectionIndicator() {
  const state = useConnectionState()
  const { label, icon: Icon, className } = presentation[state]

  return (
    <Tooltip label={label} side="bottom">
      <span
        role="status"
        aria-label={`Realtime connection: ${label}`}
        className="hover:bg-surface-hover flex size-9 items-center justify-center rounded-lg transition-colors"
      >
        <Icon aria-hidden="true" className={cn('size-4', className)} />
      </span>
    </Tooltip>
  )
}
