// Built-in sample data for the `demo` option: every name here is invented.
// Screenshots and recordings are made from this, never from real orders.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A raw snapshot, timed relative to `now` so the board always looks alive. */
export function demoSnapshot(now: number): unknown {
  return {
    orders: [
      {
        id: '20260107-091204-add-retry-backoff',
        project: 'atlas-api',
        lane: 'gpt-large',
        state: 'needs_review',
        round: 1,
        startedAt: now - 3 * HOUR,
        updatedAt: now - 2 * HOUR - 14 * MINUTE,
        title: 'Add retry with backoff to the fetch client',
      },
      {
        id: '20260107-101833-fix-invoice-rounding',
        project: 'billing-ui',
        lane: 'gpt-mini',
        state: 'check_failed',
        round: 2,
        startedAt: now - 95 * MINUTE,
        updatedAt: now - 41 * MINUTE,
        title: 'Fix rounding in invoice totals',
      },
      {
        id: '20260106-221540-migrate-search-index',
        project: 'docs-site',
        lane: 'local-qwen',
        state: 'timeout',
        round: 1,
        startedAt: now - 15 * HOUR,
        updatedAt: now - 13 * HOUR,
        title: 'Migrate the search index build',
      },
      {
        id: '20260107-113902-split-auth-middleware',
        project: 'atlas-api',
        lane: 'gpt-large',
        state: 'running',
        round: 1,
        startedAt: now - 12 * MINUTE,
        updatedAt: now - 20_000,
        title: 'Split the auth middleware',
      },
      {
        id: '20260107-112250-table-pagination',
        project: 'billing-ui',
        lane: 'gpt-mini',
        state: 'reviewing',
        round: 2,
        startedAt: now - 27 * MINUTE,
        updatedAt: now - 50_000,
        title: 'Paginate the invoices table',
      },
      {
        id: '20260107-114417-changelog-links',
        project: 'docs-site',
        lane: 'local-qwen',
        state: 'queued',
        round: 1,
        startedAt: now - 4 * MINUTE,
        updatedAt: now - 4 * MINUTE,
        title: 'Check links in the changelog',
      },
      ...[5, 7, 9, 11, 14, 19, 22].map((hours, i) => ({
        id: `20260106-0${i}0000-finished-${i}`,
        project: 'atlas-api',
        lane: 'gpt-mini',
        state: 'accepted',
        round: 1,
        startedAt: now - (hours + 1) * HOUR,
        updatedAt: now - hours * HOUR,
      })),
    ],
    lanes: [
      { name: 'gpt-large', costMonth: 72.6, budgetMonth: 70 },
      { name: 'gpt-mini', costMonth: 12.9, budgetMonth: 15 },
      { name: 'claude-review', costMonth: 6.1, budgetMonth: 30 },
      { name: 'local-qwen', costMonth: 0.42, budgetMonth: 0 },
    ],
    capacity: { running: 2, max: 4 },
  }
}
