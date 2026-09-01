import { cn } from '@/lib/cn'

const tones = {
  neutral: 'bg-sunken text-muted',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  copper: 'bg-copper-100 text-copper-600',
}

/** A small stated fact: in stock, on sale, sold out. */
export function Badge({ tone = 'neutral', className, children }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
