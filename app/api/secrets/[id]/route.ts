import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findSecretById } from "@/lib/secrets/queries";
import { revokeSecret, updateSecret } from "@/lib/secrets/actions";
import { withEvlog } from "@/lib/evlog";

export const PUT = withEvlog(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { id } = await params;

  const body = await req.json();
  if (typeof body.value !== "string" || !body.value.trim()) {
    return NextResponse.json(
      { error: "value is required (non-empty string)" },
      { status: 400 },
    );
  }

  try {
    const updated = await updateSecret({
      id,
      organizationId: orgId,
      value: body.value,
    });
    return NextResponse.json({ secret: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "Secret not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message === "Cannot update a revoked secret") {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    // Validation errors are user-facing
    const isValidation = message.includes("must start with") ||
      message.includes("Invalid") || message.includes("missing") ||
      message.includes("Unsupported provider");
    return NextResponse.json(
      { error: isValidation ? message : "Update failed" },
      { status: isValidation ? 400 : 500 },
    );
  }
});

export const DELETE = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { orgId } = await getSessionWithOrg();

  const { id } = await params;
  const secret = await findSecretById(id);

  if (!secret || secret.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await revokeSecret(id);
  return NextResponse.json({ ok: true });
});
