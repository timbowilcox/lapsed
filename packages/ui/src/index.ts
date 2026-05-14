// Foundations
export { Icon, type IconName, type IconProps } from "./components/icon";
export { cn } from "./lib/cn";
export {
  formatCurrency,
  formatCount,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  type CurrencyOptions,
  type DateFormat,
} from "./lib/format";

// shadcn-style primitives with Vellum overrides
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Input, type InputProps } from "./components/input";
export { Card, CardHeader, CardTitle, CardContent, CardFooter } from "./components/card";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Tag, tagVariants, type TagProps } from "./components/tag";
export { Avatar, avatarVariants, type AvatarProps } from "./components/avatar";
export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./components/dialog";
export { Sheet, SheetTrigger, SheetClose, SheetContent } from "./components/sheet";
export {
  Select,
  SelectValue,
  SelectGroup,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "./components/select";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/tabs";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./components/dropdown-menu";
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";
export { Panel, PanelHeader, PanelBody } from "./components/panel";
export { Toaster, toast } from "./components/toast";

// Custom composed components
export { StatusDot, type StatusDotProps } from "./components/status-dot";
export { SidebarItem, type SidebarItemProps } from "./components/sidebar-item";
export { ShopSwitcher, type ShopSwitcherProps } from "./components/shop-switcher";
export {
  AppShell,
  type AppShellProps,
  type SidebarNavItem,
  type SidebarNavSection,
} from "./components/app-shell";
export { MetricCard, type MetricCardProps } from "./components/metric-card";
export { HeroMetric, type HeroMetricProps } from "./components/hero-metric";
export {
  CampaignRow,
  type CampaignRowProps,
  type CampaignStatus,
} from "./components/campaign-row";
export { ConversationRow, type ConversationRowProps } from "./components/conversation-row";
export { RevenueChart, type RevenueChartProps } from "./components/revenue-chart";

// Skeletons
export { LapsedCustomersSkeleton } from "./components/skeletons/lapsed-customers-skeleton";
