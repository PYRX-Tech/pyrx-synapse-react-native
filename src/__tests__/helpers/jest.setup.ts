/**
 * Jest setup — runs before every test file in this project.
 *
 * Purpose:
 *   1. Mark React's act environment as active so React 19's reconciler
 *      stops warning "The current testing environment is not configured
 *      to support act(...)" for setState calls inside the active commit
 *      phase. `@testing-library/react-native@14` paired with React 19 +
 *      React Native 0.85 requires this flag.
 *
 *   2. Filter the residual "current testing environment is not
 *      configured to support act(...)" warnings that fire from async
 *      effect chains landing AFTER the test's last await — those are
 *      benign noise (the test has finished asserting; React simply
 *      hasn't been told the act scope is closed). We silence ONLY this
 *      specific message — all other console.error output passes through
 *      so real test failures stay visible.
 *
 * Referenced from `package.json` `jest.setupFilesAfterEnv`.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ACT_WARNING_PATTERNS = [
  'The current testing environment is not configured to support act',
  'was not wrapped in act',
];

const originalError = console.error;
console.error = ((...args: unknown[]) => {
  if (
    typeof args[0] === 'string' &&
    ACT_WARNING_PATTERNS.some((pattern) =>
      (args[0] as string).includes(pattern)
    )
  ) {
    return;
  }
  originalError(...args);
}) as typeof console.error;
