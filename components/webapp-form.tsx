"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AuthType, RegisterAppInput, Webapp } from "@/lib/contracts";

interface WebappFormProps {
  /** If provided, we're in edit mode */
  initial?: Webapp;
  onSuccess: (webapp: Webapp) => void;
  onCancel: () => void;
  onVaultLocked?: () => void;
}

type FormState = {
  name: string;
  url: string;
  thumbnailUrl: string;
  authType: AuthType;
  autoScreenshot: boolean;
  username: string;
  password: string;
  token: string;
  replaceCredential: boolean;
};

const EMPTY: FormState = {
  name: "",
  url: "",
  thumbnailUrl: "",
  authType: "none",
  autoScreenshot: true,
  username: "",
  password: "",
  token: "",
  replaceCredential: false,
};

function fromWebapp(w: Webapp): FormState {
  return {
    name: w.name,
    url: w.url,
    thumbnailUrl: w.thumbnailUrl ?? "",
    authType: w.authType,
    autoScreenshot: w.autoScreenshot,
    username: "",
    password: "",
    token: "",
    replaceCredential: false,
  };
}

export function WebappForm({ initial, onSuccess, onCancel, onVaultLocked }: WebappFormProps) {
  const [form, setForm] = useState<FormState>(initial ? fromWebapp(initial) : EMPTY);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const isEdit = !!initial;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validate = (): boolean => {
    const errs: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!form.url.trim()) {
      errs.url = "URL is required";
    } else {
      try {
        new URL(form.url);
      } catch {
        errs.url = "Enter a valid URL (include http:// or https://)";
      }
    }
    if (form.thumbnailUrl.trim()) {
      try {
        new URL(form.thumbnailUrl);
      } catch {
        errs.thumbnailUrl = "Enter a valid URL (include http:// or https://)";
      }
    }
    // Credential validation only for new entries or when replacing
    const needsCred = !isEdit || form.replaceCredential;
    if (needsCred) {
      if (form.authType === "basic") {
        if (!form.username.trim()) errs.username = "Username required";
        if (!form.password.trim()) errs.password = "Password required";
      }
      if (form.authType === "bearer") {
        if (!form.token.trim()) errs.token = "Token required";
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const buildCredential = (): RegisterAppInput["credential"] => {
    const needsCred = !isEdit || form.replaceCredential;
    if (!needsCred || form.authType === "none") return undefined;
    if (form.authType === "basic") {
      return { kind: "password", username: form.username, password: form.password };
    }
    if (form.authType === "bearer") {
      return { kind: "token", token: form.token };
    }
    return undefined;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    // Check vault status if we need to store credentials
    const needsCred = form.authType !== "none" && (!isEdit || form.replaceCredential);
    if (needsCred) {
      try {
        const vres = await fetch("/api/vault/status");
        if (vres.ok) {
          const vjson = (await vres.json()) as { data?: { locked: boolean } };
          if (vjson.data?.locked) {
            toast.warning("Unlock vault to save credentials");
            onVaultLocked?.();
            return;
          }
        }
      } catch {
        // best-effort
      }
    }

    setPending(true);
    try {
      const body: RegisterAppInput = {
        name: form.name.trim(),
        url: form.url.trim(),
        thumbnailUrl: form.thumbnailUrl.trim() || null,
        authType: form.authType,
        autoScreenshot: form.autoScreenshot,
        credential: buildCredential(),
      };

      let res: Response;
      if (isEdit) {
        res = await fetch(`/api/apps/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch("/api/apps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        const msg = json?.error?.message ?? (isEdit ? "Update failed" : "Registration failed");
        toast.error(msg);
        return;
      }

      // POST returns { data: { webapp, credential? } }; PATCH returns { data: Webapp }.
      const json = (await res.json()) as { data?: Webapp | { webapp: Webapp } };
      const webapp =
        json.data && "webapp" in json.data ? json.data.webapp : (json.data as Webapp | undefined);
      if (webapp) {
        toast.success(isEdit ? `${webapp.name} updated` : `${webapp.name} registered`);
        onSuccess(webapp);
      }
    } catch {
      toast.error(isEdit ? "Update failed" : "Registration failed");
    } finally {
      setPending(false);
    }
  };

  const showBasic = form.authType === "basic";
  const showBearer = form.authType === "bearer";
  const showCredFields = (showBasic || showBearer) && (!isEdit || form.replaceCredential);

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="webapp-name" className="text-sm font-medium">
          Name
        </label>
        <Input
          id="webapp-name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="My App"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "err-name" : undefined}
        />
        {errors.name && (
          <p id="err-name" className="text-xs text-destructive">
            {errors.name}
          </p>
        )}
      </div>

      {/* URL */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="webapp-url" className="text-sm font-medium">
          URL (with port if needed)
        </label>
        <Input
          id="webapp-url"
          type="url"
          value={form.url}
          onChange={(e) => set("url", e.target.value)}
          placeholder="http://localhost:15123"
          aria-invalid={!!errors.url}
          aria-describedby={errors.url ? "err-url" : undefined}
        />
        {errors.url && (
          <p id="err-url" className="text-xs text-destructive">
            {errors.url}
          </p>
        )}
      </div>

      {/* Thumbnail URL (optional override) */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="webapp-thumbnail-url" className="text-sm font-medium">
          Thumbnail URL <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <Input
          id="webapp-thumbnail-url"
          type="url"
          value={form.thumbnailUrl}
          onChange={(e) => set("thumbnailUrl", e.target.value)}
          placeholder="Defaults to the URL above"
          aria-invalid={!!errors.thumbnailUrl}
          aria-describedby={errors.thumbnailUrl ? "err-thumbnail-url" : "hint-thumbnail-url"}
        />
        {errors.thumbnailUrl ? (
          <p id="err-thumbnail-url" className="text-xs text-destructive">
            {errors.thumbnailUrl}
          </p>
        ) : (
          <p id="hint-thumbnail-url" className="text-xs text-muted-foreground">
            Pin the screenshot to a specific deep page (e.g. a dashboard view).
          </p>
        )}
      </div>

      {/* Auth type */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="webapp-auth" className="text-sm font-medium">
          Auth type
        </label>
        <select
          id="webapp-auth"
          value={form.authType}
          onChange={(e) => set("authType", e.target.value as AuthType)}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="none">None</option>
          <option value="basic">Basic (username + password)</option>
          <option value="bearer">Bearer token</option>
        </select>
      </div>

      {/* Replace credential toggle (edit mode only) */}
      {isEdit && (showBasic || showBearer) && (
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.replaceCredential}
            onChange={(e) => set("replaceCredential", e.target.checked)}
            className="rounded"
          />
          <span className="text-sm text-muted-foreground">Replace stored credential</span>
        </label>
      )}

      {/* Basic auth fields */}
      {showCredFields && showBasic && (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="webapp-username" className="text-sm font-medium">
              Username
            </label>
            <Input
              id="webapp-username"
              autoComplete="off"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              aria-invalid={!!errors.username}
              aria-describedby={errors.username ? "err-username" : undefined}
            />
            {errors.username && (
              <p id="err-username" className="text-xs text-destructive">
                {errors.username}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="webapp-password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="webapp-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "err-password" : undefined}
            />
            {errors.password && (
              <p id="err-password" className="text-xs text-destructive">
                {errors.password}
              </p>
            )}
          </div>
        </>
      )}

      {/* Bearer token field */}
      {showCredFields && showBearer && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="webapp-token" className="text-sm font-medium">
            Bearer token
          </label>
          <Input
            id="webapp-token"
            type="password"
            autoComplete="new-password"
            value={form.token}
            onChange={(e) => set("token", e.target.value)}
            aria-invalid={!!errors.token}
            aria-describedby={errors.token ? "err-token" : undefined}
          />
          {errors.token && (
            <p id="err-token" className="text-xs text-destructive">
              {errors.token}
            </p>
          )}
        </div>
      )}

      {/* Auto-screenshot */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={form.autoScreenshot}
          onChange={(e) => set("autoScreenshot", e.target.checked)}
          className="rounded"
        />
        <span className="text-sm">Auto-screenshot</span>
      </label>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? (isEdit ? "Saving…" : "Registering…") : isEdit ? "Save changes" : "Register"}
        </Button>
      </div>
    </form>
  );
}
