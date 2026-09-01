import { Search, X } from 'lucide-react'
import { Button } from './Button'
import { Input, type InputProps } from './Input'

export interface SearchInputProps extends Omit<
  InputProps,
  'leadingIcon' | 'trailingSlot' | 'type'
> {
  onClear?: () => void
}

export function SearchInput({ onClear, value, ...props }: SearchInputProps) {
  const hasValue = typeof value === 'string' && value.length > 0

  return (
    <Input
      type="search"
      value={value}
      leadingIcon={<Search className="size-4" />}
      trailingSlot={
        hasValue && onClear ? (
          <Button variant="ghost" size="xs" iconOnly aria-label="Clear search" onClick={onClear}>
            <X className="size-3.5" />
          </Button>
        ) : undefined
      }
      // Chrome and Safari draw their own clear affordance on type=search; ours
      // is the one that also resets the query state.
      className="[&::-webkit-search-cancel-button]:appearance-none"
      {...props}
    />
  )
}
