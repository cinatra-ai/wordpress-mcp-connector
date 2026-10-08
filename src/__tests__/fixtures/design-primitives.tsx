// Test-only host-module double: no product classes or variant recipes.
import * as React from "react";

export function Badge({ variant: _variant, ...props }: React.ComponentProps<"span"> & { variant?: string }) {
  return <span data-slot="badge" {...props} />;
}

export function Button({ variant: _variant, size: _size, ...props }: React.ComponentProps<"button"> & {
  variant?: string;
  size?: string;
}) {
  return <button data-slot="button" {...props} />;
}

export function Input(props: React.ComponentProps<"input">) {
  return <input data-slot="input" {...props} />;
}

export function InputGroup(props: React.ComponentProps<"div">) {
  return <div data-slot="input-group" {...props} />;
}

export function InputGroupAddon({ align: _align, ...props }: React.ComponentProps<"div"> & { align?: string }) {
  return <div data-slot="input-group-addon" {...props} />;
}

export function InputGroupInput(props: React.ComponentProps<"input">) {
  return <input data-slot="input-group-input" {...props} />;
}
