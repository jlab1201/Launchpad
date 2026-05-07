"use client";

import { Pencil, PlusCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VaultUnlockDialog } from "@/components/vault-unlock-dialog";
import { WebappForm } from "@/components/webapp-form";
import type { Webapp } from "@/lib/contracts";

interface SettingsPanelProps {
  initialApps: Webapp[];
}

function AppRow({
  webapp,
  onEdit,
  onDelete,
}: {
  webapp: Webapp;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{webapp.name}</p>
        <p className="text-xs text-muted-foreground truncate">{webapp.url}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Auth:{" "}
          {webapp.authType === "none" ? "None" : webapp.authType === "basic" ? "Basic" : "Bearer"} ·
          Screenshot: {webapp.autoScreenshot ? "on" : "off"}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="icon" aria-label={`Edit ${webapp.name}`} onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${webapp.name}`}
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function SettingsPanel({ initialApps }: SettingsPanelProps) {
  const [apps, setApps] = useState<Webapp[]>(initialApps);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Webapp | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Webapp | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [vaultUnlockOpen, setVaultUnlockOpen] = useState(false);
  // Track which action triggered the vault unlock dialog so we can resume after
  const [pendingAction, setPendingAction] = useState<"add" | null>(null);

  const notifyGrid = useCallback(() => {
    window.dispatchEvent(new Event("dashboard:apps-changed"));
  }, []);

  const handleAdded = useCallback(
    (webapp: Webapp) => {
      setApps((prev) => [...prev, webapp]);
      setAddOpen(false);
      notifyGrid();
    },
    [notifyGrid],
  );

  const handleEdited = useCallback(
    (webapp: Webapp) => {
      setApps((prev) => prev.map((a) => (a.id === webapp.id ? webapp : a)));
      setEditTarget(null);
      notifyGrid();
    },
    [notifyGrid],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeletePending(true);
    try {
      const res = await fetch(`/api/apps/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json?.error?.message ?? "Delete failed");
        return;
      }
      // Optimistic update
      setApps((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      toast.success(`${deleteTarget.name} removed`);
      setDeleteTarget(null);
      notifyGrid();
    } catch {
      toast.error("Delete failed");
    } finally {
      setDeletePending(false);
    }
  }, [deleteTarget, notifyGrid]);

  const handleVaultLocked = () => {
    setPendingAction("add");
    setAddOpen(false);
    setVaultUnlockOpen(true);
  };

  const handleVaultUnlocked = () => {
    if (pendingAction === "add") {
      setAddOpen(true);
    }
    setPendingAction(null);
  };

  // Sync with server if apps change from launchpad grid
  useEffect(() => {
    const handler = async () => {
      try {
        const res = await fetch("/api/apps");
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Webapp[] };
        if (json.data) setApps(json.data);
      } catch {
        // ignore
      }
    };
    window.addEventListener("dashboard:apps-changed", handler);
    return () => window.removeEventListener("dashboard:apps-changed", handler);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Registered Webapps</h2>
          <p className="text-sm text-muted-foreground">
            {apps.length === 0
              ? "No apps registered yet."
              : `${apps.length} app${apps.length !== 1 ? "s" : ""} registered.`}
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
          <PlusCircle className="h-4 w-4" />
          Add webapp
        </Button>
      </div>

      {/* App list */}
      {apps.length > 0 && (
        <div className="flex flex-col gap-2">
          {apps.map((webapp) => (
            <AppRow
              key={webapp.id}
              webapp={webapp}
              onEdit={() => setEditTarget(webapp)}
              onDelete={() => setDeleteTarget(webapp)}
            />
          ))}
        </div>
      )}

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Register webapp</DialogTitle>
            <DialogDescription>
              Add a new webapp to your launchpad. Credentials are encrypted in the vault.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2">
            <WebappForm
              onSuccess={handleAdded}
              onCancel={() => setAddOpen(false)}
              onVaultLocked={handleVaultLocked}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit webapp</DialogTitle>
            <DialogDescription>
              Update the webapp settings. Leave the credential fields empty to keep the existing
              one.
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <div className="mt-2">
              <WebappForm
                initial={editTarget}
                onSuccess={handleEdited}
                onCancel={() => setEditTarget(null)}
                onVaultLocked={handleVaultLocked}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete webapp</DialogTitle>
            <DialogDescription>
              Remove <span className="font-semibold">{deleteTarget?.name}</span> from the launchpad?
              Stored credentials will also be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deletePending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deletePending}
            >
              {deletePending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Vault unlock dialog */}
      <VaultUnlockDialog
        open={vaultUnlockOpen}
        onOpenChange={setVaultUnlockOpen}
        onUnlocked={handleVaultUnlocked}
      />
    </div>
  );
}
