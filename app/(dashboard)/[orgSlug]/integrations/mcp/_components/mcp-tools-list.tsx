import type { McpDiscoveredTool } from "@/lib/mcp-servers/types";

export function McpToolsList({
  tools,
}: {
  tools: McpDiscoveredTool[] | null;
}) {
  if (!tools?.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No tools discovered yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {tools.map((tool) => (
        <div
          key={tool.name}
          className="rounded-lg border bg-muted/20 px-3 py-2"
        >
          <p className="text-sm font-medium">{tool.name}</p>
          {tool.description ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {tool.description}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
