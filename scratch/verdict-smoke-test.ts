// Throwaway file to smoke-test claude-pr-review.yml's deterministic
// APPROVE/REQUEST_CHANGES verdict and claude-pr-mention.yml's @claude
// mention handling now that both are on main. Not imported by anything,
// outside tsconfig's `include` (src/**/*.ts only), so it can't break the
// typecheck workflow. Delete this file (and close/don't merge this PR)
// once both have been observed working end to end.
//
// Deliberately contains a real, blocking bug: `total` is computed from
// `prices`, but the loop bound is `prices.length` while it indexes into
// `discounts`, which is one element shorter — an out-of-bounds read that
// is `undefined` at runtime (TS can't catch this statically because the
// two arrays aren't tied together by type).
export function totalWithDiscounts(prices: number[], discounts: number[]): number {
  let total = 0;
  for (let i = 0; i < prices.length; i++) {
    total += prices[i]! - discounts[i]!;
  }
  return total;
}
