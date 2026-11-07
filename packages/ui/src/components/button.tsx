import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../cn.js";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "rounded-2xl border-transparent bg-accent text-on-accent hover:enabled:brightness-110",
        secondary: "rounded-lg border-line bg-raised text-fg hover:enabled:border-muted",
        ghost:
          "rounded-lg border-transparent bg-transparent text-muted hover:enabled:bg-raised hover:enabled:text-fg",
        danger: "rounded-lg border-line bg-raised text-fail hover:enabled:border-fail",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3.5",
        icon: "size-8 p-0",
        "icon-sm": "size-7 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Renders the child element (such as a link) with the button's look. */
    asChild?: boolean;
  };

/** Primary for the one main action of a view, secondary for the rest, ghost for quiet tools, danger for losses. */
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      {...(asChild ? {} : { type: "button" as const })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
