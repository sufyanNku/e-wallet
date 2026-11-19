import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  useId,
  useState,
  type ReactNode,
} from "react";

type Props = {
  children: ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};
type Option = { value: string; label: string; disabled: boolean };
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? text(child.props.children)
          : "",
    )
    .join("");
}
function options(children: ReactNode): Option[] {
  const result: Option[] = [];
  Children.forEach(children, (child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        disabled?: boolean;
      }>(child)
    )
      return;
    if (child.type === Fragment) result.push(...options(child.props.children));
    else if (child.type === "option") {
      const label = text(child.props.children).trim();
      result.push({
        value: String(child.props.value ?? label),
        label,
        disabled: Boolean(child.props.disabled),
      });
    }
  });
  return result;
}
export function Dropdown({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  required,
  name,
  id,
  className,
  "aria-label": label,
  "aria-labelledby": labelledBy,
}: Props) {
  const entries = options(children);
  const unique = useId();
  let empty = "empty-" + unique;
  while (entries.some((item) => item.value === empty)) empty += "_";
  const [internal, setInternal] = useState(
    String(defaultValue ?? entries[0]?.value ?? ""),
  );
  const selected = String(value ?? internal);
  const encode = (v: string) => (v === "" ? empty : v);
  return (
    <Primitive.Root
      value={encode(selected)}
      onValueChange={(next) => {
        const actual = next === empty ? "" : next;
        setInternal(actual);
        onValueChange?.(actual);
      }}
      disabled={disabled}
      required={required}
      name={name}
    >
      <Primitive.Trigger
        id={id}
        className={`select-trigger ${className ?? ""}`}
        aria-label={label}
        aria-labelledby={labelledBy}
      >
        <Primitive.Value>
          {entries.find((item) => item.value === selected)?.label ??
            "Choose an option"}
        </Primitive.Value>
        <Primitive.Icon asChild>
          <ChevronDown size={16} aria-hidden="true" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="select-menu"
          position="popper"
          sideOffset={7}
          collisionPadding={12}
        >
          <Primitive.ScrollUpButton className="select-scroll">
            <ChevronUp size={16} aria-hidden="true" />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-viewport">
            {entries.map((item) => (
              <Primitive.Item
                key={item.value}
                value={encode(item.value)}
                disabled={item.disabled}
                className="select-option"
                data-value={item.value}
                textValue={item.label}
              >
                <Primitive.ItemText>{item.label}</Primitive.ItemText>
                <Primitive.ItemIndicator className="select-check">
                  <Check size={16} aria-hidden="true" />
                </Primitive.ItemIndicator>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="select-scroll">
            <ChevronDown size={16} aria-hidden="true" />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
export function Select({ label, ...props }: Props & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label id={id + "-label"} htmlFor={id}>
        {label}
      </label>
      <Dropdown {...props} id={id} aria-labelledby={id + "-label"} />
    </div>
  );
}
