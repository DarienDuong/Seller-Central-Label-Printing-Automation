// Throwaway file to smoke-test claude-pr-review.yml / claude-pr-reply.yml on
// their first live run now that they're on main. Not imported by anything,
// outside tsconfig's `include` (src/**/*.ts only), so it can't break the
// typecheck workflow. Delete this file (and close/don't merge this PR) once
// the review has been observed firing correctly.
//
// Deliberately contains a real, obvious bug for the review to catch: the
// off-by-one below drops the last element of `items` every time.
export function allButNothing(items: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    kept.push(items[i]!);
  }
  return kept;
}
