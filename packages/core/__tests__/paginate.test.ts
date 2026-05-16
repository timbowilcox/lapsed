import { describe, expect, it } from "vitest";
import { fetchAllRows } from "../src/paginate";

const PAGE = 1000;

/**
 * Builds a page() function over a backing array, recording each (from, to)
 * call so tests can assert how many pages were fetched.
 */
function pager(rows: number[]) {
  const calls: Array<[number, number]> = [];
  const fn = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null as unknown });
  };
  return { fn, calls };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("fetchAllRows", () => {
  it("returns a single short page in one fetch", async () => {
    const { fn, calls } = pager(range(42));
    const result = await fetchAllRows<number>(fn);
    expect(result).toHaveLength(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([0, PAGE - 1]);
  });

  it("makes a second fetch when the first page is exactly PAGE_SIZE", async () => {
    // A full first page is ambiguous — there may be more. The loop must fetch
    // again and only stop on the short (here empty) page.
    const { fn, calls } = pager(range(PAGE));
    const result = await fetchAllRows<number>(fn);
    expect(result).toHaveLength(PAGE);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([PAGE, 2 * PAGE - 1]);
  });

  it("accumulates multiple pages in order", async () => {
    const { fn, calls } = pager(range(PAGE + 500));
    const result = await fetchAllRows<number>(fn);
    expect(result).toHaveLength(PAGE + 500);
    // Order preserved across pages.
    expect(result[0]).toBe(0);
    expect(result[PAGE]).toBe(PAGE);
    expect(result[PAGE + 499]).toBe(PAGE + 499);
    expect(calls).toHaveLength(2);
  });

  it("treats a null data page as empty and terminates", async () => {
    const result = await fetchAllRows<number>(() =>
      Promise.resolve({ data: null, error: null }),
    );
    expect(result).toEqual([]);
  });

  it("throws on a first-page error rather than returning a partial result", async () => {
    await expect(
      fetchAllRows<number>(() =>
        Promise.resolve({ data: null, error: { message: "boom" } }),
      ),
    ).rejects.toEqual({ message: "boom" });
  });

  it("throws on a later-page error without returning the earlier pages", async () => {
    let call = 0;
    await expect(
      fetchAllRows<number>(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({ data: range(PAGE), error: null as unknown });
        }
        return Promise.resolve({ data: null, error: { message: "page 2 failed" } });
      }),
    ).rejects.toEqual({ message: "page 2 failed" });
    expect(call).toBe(2);
  });
});
