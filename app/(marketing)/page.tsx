import Link from "next/link";

export default function Page() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="text-center">
        <h1 className="text-2xl font-medium">Polaris</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Agent orchestration system
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Get started
        </Link>
      </div>
    </div>
  );
}
