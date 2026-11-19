import type { Locator } from "@playwright/test";
export async function chooseOption(
  control: Locator,
  choice: string | { value?: string; label?: string },
) {
  await control.click();
  const page = control.page();
  const option =
    typeof choice === "object" && choice.label !== undefined
      ? page.getByRole("option", { name: choice.label, exact: true })
      : page
          .getByRole("listbox")
          .locator(
            '[role="option"][data-value=' +
              JSON.stringify(
                typeof choice === "string" ? choice : choice.value,
              ) +
              "]",
          );
  await option.click();
}
