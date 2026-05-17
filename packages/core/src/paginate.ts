// Pagination helper — Supabase caps a single select at ~1000 rows. Attribution
// math feeds Sprint 09 billing; a silently truncated fetch would under-count
// revenue (criterion 7 — drift must stay < 1%). `fetchAllRows` pages through a
// query with `.range()` until a short page signals the end.

const PAGE_SIZE = 1000;

interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

/**
 * Exhaustively fetches every row of a query, paging in PAGE_SIZE chunks via
 * `.range(from, to)`. `page` must apply all filters and return the builder with
 * `.range()` already called — e.g.:
 *
 *   fetchAllRows<OrderRow>((from, to) =>
 *     client.from("orders").select("id").eq("merchant_id", m).range(from, to))
 *
 * Throws the query error on any page failure rather than returning a partial
 * result — a swallowed error here would silently mis-state attributed revenue.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

/** Splits an array into chunks of at most `size` elements. */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Default cap on the number of ids in a single `.in(...)` filter. PostgREST
 * encodes `.in()` values in the request URL; a few thousand UUIDs would
 * overflow practical URL limits. Callers chunk their id list by this size and
 * page each chunk with `fetchAllRows`.
 */
export const IN_CLAUSE_CHUNK = 200;
