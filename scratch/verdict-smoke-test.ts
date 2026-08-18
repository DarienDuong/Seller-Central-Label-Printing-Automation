// Throwaway file to smoke-test claude-pr-review.yml's deterministic
// APPROVE/REQUEST_CHANGES verdict and claude-pr-mention.yml's @claude
// mention handling now that both are on main. Not imported by anything,
// outside tsconfig's `include` (src/**/*.ts only), so it can't break the
// typecheck workflow. Delete this file (and close/don't merge this PR)
// once both have been observed working end to end.
//
// Fixed: bound the loop by the shorter array, so a SKU past the end of
// `discounts` is treated as having no discount instead of being read
// out of bounds.
export function totalWithDiscounts(prices: number[], discounts: number[]): number {
  let total = 0;
  for (let i = 0; i < prices.length; i++) {
    total += prices[i]! - (discounts[i] ?? 0);
  }
  return total;
}
