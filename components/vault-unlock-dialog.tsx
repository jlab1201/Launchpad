"use client";

import { Eye, EyeOff, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface VaultUnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnlocked?: () => void;
}

export function VaultUnlockDialog({ open, onOpenChange, onUnlocked }: VaultUnlockDialogProps) {
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clear state on close
  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setShowPass(false);
      setError(null);
      setPending(false);
    } else {
      // Focus input when opened
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });

      if (res.ok) {
        setPassphrase("");
        onOpenChange(false);
        toast.success("Vault unlocked");
        onUnlocked?.();
      } else {
        const json = (await res.json()) as { error?: { message?: string } };
        const msg = json?.error?.message ?? "Wrong passphrase";
        // Don't leak specifics — just show generic message
        setError("Wrong passphrase");
        // Log actual error only in dev
        if (process.env.NODE_ENV === "development") {
          console.error("[vault unlock]", msg);
        }
      }
    } catch {
      setError("Could not reach server");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-amber-500" />
            Unlock Vault
          </DialogTitle>
          <DialogDescription>
            Enter your master passphrase to decrypt credentials.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="mt-2 flex flex-col gap-4">
          <div className="relative">
            <Input
              ref={inputRef}
              type={showPass ? "text" : "password"}
              placeholder="Master passphrase"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                if (error) setError(null);
              }}
              autoComplete="current-password"
              aria-label="Master passphrase"
              aria-invalid={error !== null}
              aria-describedby={error ? "vault-error" : undefined}
              className="pr-10"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowPass((v) => !v)}
              aria-label={showPass ? "Hide passphrase" : "Show passphrase"}
            >
              {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p id="vault-error" role="alert" className="text-sm text-destructive font-medium">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !passphrase.trim()}>
              {pending ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
