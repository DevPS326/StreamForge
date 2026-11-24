import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/ui";

export const buttonVariants = cva(
  "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-[#6940db] text-white shadow-sm hover:bg-[#5e35ce] dark:bg-[#a68aff] dark:text-[#171027] dark:hover:bg-[#bcaaFF]",
        outline: "border-line bg-surface text-ink hover:bg-line/35",
        ghost: "border-transparent text-muted hover:bg-line/45 hover:text-ink",
        danger: "border-transparent bg-danger text-white hover:bg-danger/85",
      },
      size: {
        default: "h-10",
        small: "h-9 min-h-9 px-3",
        icon: "size-10 px-0",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

interface Props
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
