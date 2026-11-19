import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowUpRight, WalletCards, Eye, EyeOff } from "lucide-react";
import {
  useId,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

export function Button({
  children,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button {...props} className={`button ${variant} ${props.className ?? ""}`}>
      {children}
    </button>
  );
}
export function Field({
  label,
  error,
  hint,
  type,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const password = type === "password";
  useEffect(() => {
    if (props.value === "" || props.disabled || !password) setRevealed(false);
  }, [props.value, props.disabled, password]);
  useEffect(() => {
    if (!password) return;
    const hide = () => setRevealed(false);
    const visibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [password]);
  const input = (
    <input
      {...props}
      type={password && revealed ? "text" : type}
      id={id}
      aria-invalid={Boolean(error)}
      aria-describedby={error || hint ? `${id}-help` : undefined}
    />
  );
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {password ? (
        <div className="password-input">
          {input}
          <button
            className="password-toggle"
            type="button"
            disabled={props.disabled}
            aria-label={`${revealed ? "Hide" : "Show"} ${label}`}
            aria-controls={id}
            aria-pressed={revealed}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? (
              <EyeOff size={19} aria-hidden="true" />
            ) : (
              <Eye size={19} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : (
        input
      )}
      {(error || hint) && (
        <small id={`${id}-help`} className={error ? "error" : "muted"}>
          {error || hint}
        </small>
      )}
    </div>
  );
}
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "error" | "success";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <WalletCards size={32} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="section-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="Close dialog">
                <X size={20} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Address({ value }: { value: string }) {
  return <code className="address">{value}</code>;
}
export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      className="text-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight size={16} />
    </a>
  );
}
export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
