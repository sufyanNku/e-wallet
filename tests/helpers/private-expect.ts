import { expect as playwrightExpect, type Locator } from "@playwright/test";
// Locator assertions in Playwright 1.65 attach a DOM snapshot independently of
// PLAYWRIGHT_NO_COPY_PROMPT. Boolean polling avoids that path on vault screens.
function assertions(locator: Locator, negated = false) {
  const check = async (
    predicate: () => Promise<boolean>,
    options: { timeout?: number } = {},
  ) =>
    playwrightExpect
      .poll(predicate, {
        timeout: options.timeout ?? 5000,
        message: "Private browser assertion failed (page content omitted).",
      })
      .toBe(!negated);
  return {
    get not() {
      return assertions(locator, !negated);
    },
    toBeVisible: (options?: { timeout?: number }) =>
      check(() => locator.isVisible(), options),
    toBeDisabled: (options?: { timeout?: number }) =>
      check(() => locator.isDisabled(), options),
    toHaveText: (text: string, options?: { timeout?: number }) =>
      check(async () => (await locator.textContent())?.trim() === text, options),
    toHaveValue: (text: string, options?: { timeout?: number }) =>
      check(async () => (await locator.inputValue()) === text, options),
    toHaveCount: (count: number, options?: { timeout?: number }) =>
      check(async () => (await locator.count()) === count, options),
    toContainText: (text: string | RegExp, options?: { timeout?: number }) =>
      check(async () => {
        const value = (await locator.textContent()) ?? "";
        return typeof text === "string"
          ? value.includes(text)
          : text.test(value);
      }, options),
  };
}
export const expect = Object.assign(
  ((actual: unknown, ...args: unknown[]) =>
    actual && typeof actual === "object" && "isVisible" in actual
      ? assertions(actual as Locator)
      : playwrightExpect(actual, ...(args as []))) as typeof playwrightExpect,
  playwrightExpect,
);
