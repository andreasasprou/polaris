"use client"

import { useRouter } from "next/navigation"
import {
  ChevronsUpDownIcon,
  CheckIcon,
  PlusIcon,
} from "lucide-react"
import { authClient } from "@/lib/auth/client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"

export function OrgSwitcher() {
  const router = useRouter()
  const { data: activeOrg, isPending: activeOrgPending } =
    authClient.useActiveOrganization()
  const { data: orgs, isPending: orgsPending } =
    authClient.useListOrganizations()

  const isPending = activeOrgPending || orgsPending

  async function handleSwitch(organizationId: string) {
    await authClient.organization.setActive({ organizationId })
    window.location.href = "/dashboard"
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              {isPending ? (
                <>
                  <Skeleton className="size-8 rounded-lg" />
                  <div className="grid flex-1 gap-1">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold">
                    {activeOrg?.name?.charAt(0).toUpperCase() ?? "?"}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">
                      {activeOrg?.name ?? "No organization"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      Workspace
                    </span>
                  </div>
                </>
              )}
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side="right"
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {orgs?.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onClick={() => handleSwitch(org.id)}
              >
                <div className="flex aspect-square size-6 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold">
                  {org.name.charAt(0).toUpperCase()}
                </div>
                <span className="ml-2 truncate">{org.name}</span>
                {org.id === activeOrg?.id && (
                  <CheckIcon className="ml-auto size-4" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/onboarding")}>
              <PlusIcon className="size-4" />
              <span>Create new organization</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
