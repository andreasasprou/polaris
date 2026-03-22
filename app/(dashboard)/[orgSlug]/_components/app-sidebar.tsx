"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  PlusIcon,
  BotIcon,
  SettingsIcon,
  LogOutIcon,
  ChevronsUpDownIcon,
  ChevronRightIcon,
  LayoutDashboardIcon,
  PlayIcon,
} from "lucide-react"
import { authClient } from "@/lib/auth/client"
import { useOrgSlug } from "@/hooks/use-org-path"
import { useSidebarSessions, relativeTime } from "@/hooks/use-sidebar-sessions"
import { useSidebarKeyboard } from "@/hooks/use-sidebar-keyboard"
import { SessionStatusIcon } from "@/components/sidebar/session-status-icon"
import { OrgSwitcher } from "./org-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const INITIAL_VISIBLE = 5

export function AppSidebar() {
  const pathname = usePathname()
  const orgSlug = useOrgSlug()
  const { groups, loading } = useSidebarSessions()
  useSidebarKeyboard()

  function scopedHref(path: string) {
    return `/${orgSlug}${path}`
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {/* Actions group */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="New Session">
                  <Link href={scopedHref("/sessions/new")}>
                    <PlusIcon />
                    <span>New Session</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith(scopedHref("/automations"))}
                  tooltip="Automations"
                >
                  <Link href={scopedHref("/automations")}>
                    <BotIcon />
                    <span>Automations</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Sessions group */}
        <SidebarGroup className="flex-1 overflow-auto">
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            {loading && groups.length === 0 ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                Loading...
              </div>
            ) : groups.length === 0 ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                No sessions yet
              </div>
            ) : (
              <SidebarMenu>
                {groups.map((group) => (
                  <RepoGroupItem
                    key={group.key}
                    label={group.label}
                    sessions={group.sessions}
                    activeCount={group.activeCount}
                    pathname={pathname}
                    orgSlug={orgSlug}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {/* Demoted nav: Dashboard + Runs as small items */}
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === scopedHref("/dashboard")}
              tooltip="Dashboard"
            >
              <Link href={scopedHref("/dashboard")}>
                <LayoutDashboardIcon />
                <span>Dashboard</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith(scopedHref("/runs"))}
              tooltip="Runs"
            >
              <Link href={scopedHref("/runs")}>
                <PlayIcon />
                <span>Runs</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith(scopedHref("/settings"))}
              tooltip="Settings"
            >
              <Link href={scopedHref("/settings")}>
                <SettingsIcon />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {/* Account dropdown */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
                    <SettingsIcon />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">Account</span>
                  </div>
                  <ChevronsUpDownIcon />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                side="right"
                align="end"
                sideOffset={4}
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem asChild>
                    <Link href={scopedHref("/settings")}>
                      <SettingsIcon />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    authClient.signOut({
                      fetchOptions: {
                        onSuccess: () => {
                          window.location.href = "/login"
                        },
                      },
                    })
                  }
                >
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}

// ── Repo group collapsible ──

function RepoGroupItem({
  label,
  sessions,
  activeCount,
  pathname,
  orgSlug,
}: {
  label: string
  sessions: { id: string; status: string; title: string; createdAt: string; needsAttention: boolean }[]
  activeCount: number
  pathname: string
  orgSlug: string
}) {
  const [expanded, setExpanded] = useState(false)
  const visibleSessions = expanded
    ? sessions
    : sessions.slice(0, INITIAL_VISIBLE)
  const hasMore = sessions.length > INITIAL_VISIBLE

  return (
    <Collapsible defaultOpen asChild>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className="text-xs font-medium text-sidebar-foreground/70">
            <ChevronRightIcon className="transition-transform duration-200 [[data-state=open]>&]:rotate-90" />
            <span className="truncate">{label}</span>
            {activeCount > 0 && (
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {activeCount}
              </span>
            )}
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {visibleSessions.map((session) => {
              const href = `/${orgSlug}/sessions/${session.id}`
              const isActive = pathname === href
              return (
                <SidebarMenuSubItem key={session.id}>
                  <SidebarMenuSubButton asChild size="sm" isActive={isActive}>
                    <Link href={href}>
                      <SessionStatusIcon
                        status={session.status}
                        needsAttention={session.needsAttention}
                      />
                      <span className="truncate flex-1">{session.title}</span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {relativeTime(session.createdAt)}
                      </span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
            {hasMore && !expanded && (
              <SidebarMenuSubItem>
                <button
                  onClick={() => setExpanded(true)}
                  className="w-full px-2 py-1 text-[11px] text-muted-foreground hover:text-sidebar-accent-foreground text-left"
                >
                  {sessions.length - INITIAL_VISIBLE} more...
                </button>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
