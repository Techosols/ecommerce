import { Outlet } from 'react-router-dom'
import { Store } from 'lucide-react'
import { env } from '@/app/env'

/**
 * The signed-out shell.
 *
 * A single centred column rather than the marketing split-screen a storefront
 * would use: nobody discovers an admin, they are given the address, so the page
 * exists to be signed into quickly and say nothing about the shop to anyone who
 * finds it.
 */
export function AuthLayout() {
  return (
    <div className="bg-canvas flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="bg-brand-600 mb-3 flex size-11 items-center justify-center rounded-xl">
            <Store aria-hidden="true" className="size-6 text-white" />
          </span>
          <h1 className="text-ink text-lg font-semibold">{env.appName}</h1>
          <p className="text-muted mt-1 text-sm">Sign in to manage the store.</p>
        </div>

        <div className="bg-surface border-line rounded-card shadow-card border p-6">
          <Outlet />
        </div>

        <p className="text-faint mt-6 text-center text-xs">
          Authorised staff only. Activity in this application is recorded.
        </p>
      </div>
    </div>
  )
}
