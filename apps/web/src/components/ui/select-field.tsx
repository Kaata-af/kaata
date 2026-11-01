import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

export type SelectFieldOption = { value: string; label: React.ReactNode; disabled?: boolean };
type SelectFieldProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectTrigger>,
  "value" | "onChange" | "children" | "dir"
> & {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectFieldOption[];
  placeholder?: React.ReactNode;
  dir?: "ltr" | "rtl";
  name?: string;
  required?: boolean;
};

// Shared composition of shadcn Select. Empty filter choices have a real menu
// item; Radix reserves its own empty value for an unselected placeholder.
export const SelectField = React.forwardRef<HTMLButtonElement, SelectFieldProps>(
  (
    {
      value,
      onValueChange,
      options,
      placeholder,
      dir = "ltr",
      name,
      required,
      disabled,
      ...triggerProps
    },
    forwardedRef,
  ) => {
    const emptyValue = `kaata-empty:${React.useId()}`;
    const selected = options.find((option) => option.value === value);
    const [container, setContainer] = React.useState<HTMLDialogElement | null>(null);
    const triggerRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
        // A body's portal cannot receive input above a modal native dialog.
        // Keep the menu in that dialog's top layer when editing or subscribing.
        setContainer(node?.closest("dialog") ?? null);
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );
    const encode = (option: string) => (option === "" ? emptyValue : option);
    return (
      <Select
        dir={dir}
        value={selected ? encode(value) : ""}
        onValueChange={(next) => onValueChange(next === emptyValue ? "" : next)}
        disabled={disabled}
        required={required}
      >
        <SelectTrigger ref={triggerRef} dir={dir} disabled={disabled} {...triggerProps}>
          <SelectValue data-slot="select-value" placeholder={placeholder}>
            {selected?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent container={container} dir={dir}>
          {options.map((option) => (
            <SelectItem key={option.value} value={encode(option.value)} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
        {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
      </Select>
    );
  },
);
SelectField.displayName = "SelectField";
