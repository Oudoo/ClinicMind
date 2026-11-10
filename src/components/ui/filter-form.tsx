"use client";

import * as React from "react";

/**
 * A filter form (GET) that applies as soon as a choice is made: a select, a date, a tick.
 * Text fields apply on Enter, so a search box needs no "Apply" button beside the filters.
 */
export function FilterForm({ children, onChange, ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form
      method="get"
      {...props}
      onChange={(e) => {
        onChange?.(e);
        const field = e.target;
        const choice =
          field instanceof HTMLSelectElement ||
          (field instanceof HTMLInputElement && ["date", "month", "checkbox", "radio"].includes(field.type));
        if (choice) e.currentTarget.requestSubmit();
      }}
    >
      {children}
    </form>
  );
}
