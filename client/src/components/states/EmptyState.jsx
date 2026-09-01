/** Nothing here, and why. Never just "No results". */
export function EmptyState({ icon, title, description, actions }) {
  return (
    <div className="border-line bg-surface flex flex-col items-center gap-3 rounded-card border border-dashed px-6 py-16 text-center">
      {icon ? <span className="text-faint">{icon}</span> : null}
      <p className="text-ink font-display text-lg">{title}</p>
      {description ? <p className="text-muted max-w-md text-sm">{description}</p> : null}
      {actions ? <div className="mt-1 flex gap-2">{actions}</div> : null}
    </div>
  )
}
