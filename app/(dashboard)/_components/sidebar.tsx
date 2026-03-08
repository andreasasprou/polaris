"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth/client";

const navigation = [
  { name: "Dashboard", href: "/dashboard" },
  { name: "Automations", href: "/automations" },
  { name: "Runs", href: "/runs" },
  { name: "Sessions", href: "/sessions" },
  { name: "Integrations", href: "/integrations" },
  { name: "Settings", href: "/settings" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-background">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link href="/dashboard" className="text-lg font-semibold">
          Polaris
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {navigation.map((item) => {
          const active =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium ${
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-2">
        <button
          onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/login"; } } })}
          className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
