"use client";

import { usePathname } from "next/navigation";

/**
 * The home page is a full-bleed stage; every instrument page keeps the measured column.
 */
export function PageShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/") return <>{children}</>;
  return <div className="shell py-10">{children}</div>;
}
