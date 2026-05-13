import { icons, type LucideProps } from "lucide-react";
import { forwardRef } from "react";

export type IconName = keyof typeof icons;

export interface IconProps extends LucideProps {
  name: IconName;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { name, strokeWidth = 1.75, ...rest },
  ref,
) {
  const LucideIcon = icons[name];
  return <LucideIcon ref={ref} strokeWidth={strokeWidth} {...rest} />;
});
