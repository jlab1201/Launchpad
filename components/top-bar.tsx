"use client";

import { LayoutGrid, Lock, LockOpen, Moon, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { VaultUnlockDialog } from "@/components/vault-unlock-dialog";
import { cn } from "@/lib/utils";

type VaultStatus = "locked" | "unlocked" | "loading";

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-9 w-9" />;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function VaultIndicator() {
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [unlockOpen, setUnlockOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/vault/status");
      if (!res.ok) return;
      const json = (await res.json()) as { data?: { locked: boolean } };
      setStatus(json.data?.locked ? "locked" : "unlocked");
    } catch {
      // silently keep last known state
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleLock = async () => {
    try {
      const res = await fetch("/api/vault/lock", { method: "POST" });
      if (!res.ok) {
        toast.error("Failed to lock vault");
        return;
      }
      setStatus("locked");
      toast.success("Vault locked");
    } catch {
      toast.error("Failed to lock vault");
    }
  };

  if (status === "loading") {
    return <div className="h-8 w-24 skeleton rounded-md" />;
  }

  if (status === "unlocked") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleLock()}
        className="gap-1.5 text-xs font-medium text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300"
        aria-label="Vault unlocked — click to lock"
      >
        <LockOpen className="h-3.5 w-3.5" />
        Unlocked
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setUnlockOpen(true)}
        className="gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300"
        aria-label="Vault locked — click to unlock"
      >
        <Lock className="h-3.5 w-3.5" />
        Locked
      </Button>
      <VaultUnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        onUnlocked={() => setStatus("unlocked")}
      />
    </>
  );
}

const navLinks = [
  { href: "/", label: "Launchpad", icon: LayoutGrid },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function TopBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        {/* Brand — app title, not a clickable tab */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold shadow-sm">
            D
          </div>
          <span className="hidden sm:inline text-lg font-bold tracking-tight text-foreground">
            Dashboard
          </span>
        </div>

        {/* Visual separator between title and tabs */}
        <div className="h-6 w-px bg-border" aria-hidden="true" />

        {/* Nav */}
        <nav className="flex items-center gap-1" aria-label="Main navigation">
          {navLinks.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Vault + theme */}
        <div className="flex items-center gap-1">
          <VaultIndicator />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
