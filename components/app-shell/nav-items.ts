import {
  ArrowLeftRight,
  ArrowUpDown,
  Briefcase,
  ChartLine,
  Eye,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Extra words the command palette also matches on. */
  keywords: string;
}

/** Every top-level destination, in sidebar order. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard, keywords: "home overview portfolio value" },
  { href: "/holdings", label: "Holdings", Icon: Briefcase, keywords: "positions stocks shares closed" },
  { href: "/watchlist", label: "Watchlist", Icon: Eye, keywords: "track paper simulator alerts" },
  { href: "/benchmarks", label: "Benchmarks", Icon: ChartLine, keywords: "compare sp500 nasdaq dow sti twr xirr" },
  { href: "/transactions", label: "Transactions", Icon: ArrowLeftRight, keywords: "buy sell dividend ledger" },
  { href: "/import-export", label: "Import / Export", Icon: ArrowUpDown, keywords: "csv backup msn msp" },
  { href: "/settings", label: "Settings", Icon: Settings, keywords: "currency theme risk free password" },
];

