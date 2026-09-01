/**
 * Public surface of the `analytics` feature (§2.2).
 *
 * Analytics reads everything and is read by nothing: it sits at the very top of
 * the dependency graph, which is why it may query orders and inventory directly
 * without any other feature learning that it exists.
 */
export { analyticsService } from './analytics.service.js'
export type { DailySales } from './analytics.service.js'
