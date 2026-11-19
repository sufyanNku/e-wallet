// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type FormEvent } from "react";
import { Field } from "@ewallet/ui";

afterEach(cleanup);
function Form({ submit }: { submit: (event: FormEvent) => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return (
    <form onSubmit={submit}>
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Field
        label="Confirm password"
        type="password"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <Field label="Name" value="Public name" readOnly />
      <button
        type="button"
        onClick={() => {
          setPassword("");
          setConfirmation("");
        }}
      >
        Clear passwords
      </button>
      <button type="submit">Save</button>
    </form>
  );
}

it("toggles password visibility without changing its value, losing pointer focus or submitting", async () => {
  const user = userEvent.setup();
  const submit = vi.fn((event: FormEvent) => event.preventDefault());
  render(<Form submit={submit} />);
  const input = screen.getByLabelText("Password", {}) as HTMLInputElement;
  expect(input.type).toBe("password");
  await user.type(input, "Visible only in this test");
  await user.click(screen.getByRole("button", { name: "Show Password" }));
  expect(input.type).toBe("text");
  expect(input.value).toBe("Visible only in this test");
  expect(document.activeElement).toBe(input);
  const hide = screen.getByRole("button", {
    name: "Hide Password",
  });
  expect(hide.getAttribute("aria-pressed")).toBe("true");
  expect(hide.getAttribute("aria-controls")).toBe(input.id);
  expect(submit).not.toHaveBeenCalled();
  await user.click(hide);
  expect(input.type).toBe("password");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(submit).toHaveBeenCalledTimes(1);
});

it("supports keyboard activation and independent password/confirmation controls", async () => {
  const user = userEvent.setup();
  render(<Form submit={(event) => event.preventDefault()} />);
  const input = screen.getByLabelText("Password", {}) as HTMLInputElement;
  const confirmation = screen.getByLabelText(
    "Confirm password",
    {},
  ) as HTMLInputElement;
  await user.type(input, "Keyboard visibility check");
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Show Password" }),
  );
  await user.keyboard(" ");
  expect(input.type).toBe("text");
  expect(confirmation.type).toBe("password");
  await user.click(
    screen.getByRole("button", { name: "Show Confirm password" }),
  );
  expect(confirmation.type).toBe("text");
  expect(input.type).toBe("text");
  expect(screen.queryByRole("button", { name: "Show Name" })).toBeNull();
});

it("masks revealed passwords when the window loses focus or the form clears them", async () => {
  const user = userEvent.setup();
  render(<Form submit={(event) => event.preventDefault()} />);
  const input = screen.getByLabelText("Password", {}) as HTMLInputElement;
  await user.type(input, "Mask after background");
  await user.click(screen.getByRole("button", { name: "Show Password" }));
  fireEvent.blur(window);
  expect(input.type).toBe("password");
  await user.click(screen.getByRole("button", { name: "Show Password" }));
  await user.click(screen.getByRole("button", { name: "Clear passwords" }));
  expect(input.type).toBe("password");
  expect(input.value).toBe("");
  await user.type(input, "New entry stays masked");
  expect(input.type).toBe("password");
});
