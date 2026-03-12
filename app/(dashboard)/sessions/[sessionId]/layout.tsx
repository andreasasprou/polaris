/**
 * Session detail layout — fills the available space with overflow hidden
 * so the session page can manage its own internal scrolling.
 *
 * This overrides the parent layout's `overflow-y-auto` by consuming
 * the full height and clipping overflow, allowing the session chat's
 * scroll container to be properly height-constrained.
 */
export default function SessionDetailLayout({
  children,
}: {
  children: React.ReactNode;
  params: Promise<{ sessionId: string }>;
}) {
  return (
    <div className="absolute inset-0 overflow-hidden">{children}</div>
  );
}
