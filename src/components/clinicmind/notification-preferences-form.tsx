"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { BellRing, Loader2, Mail, MonitorSmartphone, Send } from "lucide-react";
import type { NotificationKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { EMAIL_DEFAULT_ON, KIND_HINTS, KIND_LABELS, NOTIFICATION_KINDS } from "@/modules/notifications/kinds";
import { emitNotificationsChanged, emitPreferencesChanged } from "./notification-shared";

/**
 * The preferences form: a matrix of kinds × (in-app, e-mail), the browser
 * notifications switch (which asks the browser for permission), the digest
 * hour on the clinic clock, Save and "Send me a test notification".
 */
export interface PreferencesValue {
  inApp: Record<string, boolean>;
  email: Record<string, boolean>;
  browser: boolean;
  digestHour: number | null;
}

type Permission = "default" | "granted" | "denied" | "unsupported";

/** Re-read `Notification.permission` after we asked for it (and if another tab changed it). */
const PERMISSION_EVENT = "clinicmind:notification-permission";
const subscribePermission = (onChange: () => void) => {
  window.addEventListener(PERMISSION_EVENT, onChange);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(PERMISSION_EVENT, onChange);
    window.removeEventListener("focus", onChange);
  };
};
const readPermission = (): Permission =>
  typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

function effective(map: Record<string, boolean>, kind: NotificationKind, fallback: boolean): boolean {
  const v = map[kind];
  return typeof v === "boolean" ? v : fallback;
}

export function NotificationPreferencesForm({
  initial,
  timezone,
  email,
}: {
  initial: PreferencesValue;
  timezone: string;
  email: string | null;
}) {
  const id = useId();
  const { toast } = useToast();
  const [inApp, setInApp] = useState<Record<string, boolean>>(initial.inApp);
  const [mail, setMail] = useState<Record<string, boolean>>(initial.email);
  const [browser, setBrowser] = useState(initial.browser);
  const [digestHour, setDigestHour] = useState<number | null>(initial.digestHour);
  const permission = useSyncExternalStore(subscribePermission, readPermission, () => "default" as Permission);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function toggle(kind: NotificationKind, channel: "inApp" | "email", value: boolean) {
    setDirty(true);
    if (channel === "inApp") setInApp((m) => ({ ...m, [kind]: value }));
    else setMail((m) => ({ ...m, [kind]: value }));
  }

  async function toggleBrowser() {
    setNotice(null);
    if (browser) {
      setBrowser(false);
      setDirty(true);
      return;
    }
    if (permission === "unsupported") {
      setNotice("This browser does not support desktop notifications. The bell and e-mail still work.");
      return;
    }
    let state: NotificationPermission = Notification.permission;
    if (state === "default") {
      try {
        state = await Notification.requestPermission();
      } catch {
        state = Notification.permission;
      }
    }
    window.dispatchEvent(new Event(PERMISSION_EVENT));
    if (state === "granted") {
      setBrowser(true);
      setDirty(true);
      return;
    }
    if (state === "denied") {
      setNotice(
        "Your browser has blocked notifications for this site. Allow them in the site settings (the lock icon next to the address), then switch this on again.",
      );
    } else {
      setNotice("Permission was not granted. Switch this on again to ask the browser once more.");
    }
    setBrowser(false);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const body = {
        inApp: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, effective(inApp, k, true)])),
        email: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, effective(mail, k, EMAIL_DEFAULT_ON.includes(k))])),
        browser,
        digestHour,
      };
      const res = await apiFetch<{ preferences: PreferencesValue }>("/api/notifications/preferences", { method: "PATCH", body });
      setInApp(res.preferences.inApp);
      setMail(res.preferences.email);
      setBrowser(res.preferences.browser);
      setDigestHour(res.preferences.digestHour);
      setDirty(false);
      emitPreferencesChanged({ browser: res.preferences.browser });
      toast({ title: "Notification preferences saved", tone: "success" });
    } catch (err) {
      toast({ title: "Could not save preferences", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (testing) return;
    setTesting(true);
    try {
      const res = await apiFetch<{ emailed: boolean; emailEnabled: boolean; to: string | null; browser: boolean }>("/api/notifications/test", {
        method: "POST",
        body: {},
      });
      emitNotificationsChanged("preferences");
      const parts = ["It is in your bell now."];
      if (res.emailed && res.to) parts.push(`A copy went to ${res.to}.`);
      else if (res.emailEnabled) parts.push("The e-mail could not be sent; check the server's SMTP settings.");
      else parts.push("E-mail is off for System notifications, so no copy was sent.");
      if (res.browser && permission === "granted") parts.push("Watch for the desktop notification within a few seconds.");
      toast({ title: "Test notification sent", description: parts.join(" "), tone: "success", durationMs: 8000 });
    } catch (err) {
      toast({ title: "Could not send the test notification", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="notification-preferences">
      <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Defaults:</span> everything reaches the bell unless you switch it off. E-mail is off
        by default, except <span className="font-medium text-foreground">escalations</span> and{" "}
        <span className="font-medium text-foreground">metric alerts</span>, which reach you by every channel until you say otherwise
        {email ? (
          <>
            {" "}
            (e-mails go to <span className="font-mono">{email}</span>)
          </>
        ) : null}
        .
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2 border-b border-border bg-muted/60 px-3 py-2 sm:grid-cols-[1fr_6rem_6rem]">
          <span className="data-label">Event</span>
          <span className="data-label text-center">In-app</span>
          <span className="data-label text-center">E-mail</span>
        </div>
        <ul className="divide-y divide-border">
          {NOTIFICATION_KINDS.map((kind) => {
            const appOn = effective(inApp, kind, true);
            const mailDefault = EMAIL_DEFAULT_ON.includes(kind);
            const mailOn = effective(mail, kind, mailDefault);
            return (
              <li key={kind} className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2 px-3 py-2.5 sm:grid-cols-[1fr_6rem_6rem]">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {KIND_LABELS[kind]}
                    {mailDefault ? <span className="ml-2 font-mono text-[10px] uppercase text-warning">e-mail by default</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{KIND_HINTS[kind]}</p>
                </div>
                <label className="flex justify-center" title={`In-app · ${KIND_LABELS[kind]}`}>
                  <span className="sr-only">In-app {KIND_LABELS[kind]}</span>
                  <Checkbox checked={appOn} onChange={(e) => toggle(kind, "inApp", e.target.checked)} data-testid={`pref-inapp-${kind}`} />
                </label>
                <label className="flex justify-center" title={`E-mail · ${KIND_LABELS[kind]}`}>
                  <span className="sr-only">E-mail {KIND_LABELS[kind]}</span>
                  <Checkbox checked={mailOn} onChange={(e) => toggle(kind, "email", e.target.checked)} data-testid={`pref-email-${kind}`} />
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <MonitorSmartphone className="mt-0.5 h-4 w-4 text-accent" />
              <div>
                <p className="text-sm font-medium" id={`${id}-browser-label`}>
                  Browser notifications
                </p>
                <p className="text-xs text-muted-foreground">
                  A desktop pop-up for new notifications while ClinicMind is open in a tab, even in the background.
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={browser}
              aria-labelledby={`${id}-browser-label`}
              onClick={() => void toggleBrowser()}
              data-testid="pref-browser-switch"
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                browser ? "bg-accent" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "inline-block h-5 w-5 transform rounded-full bg-card shadow transition-transform",
                  browser ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
          <p className="font-mono text-[10px] uppercase text-muted-foreground">
            permission: {permission === "unsupported" ? "not supported here" : permission === "default" ? "not asked yet" : permission}
          </p>
          {notice ? <Alert tone="info">{notice}</Alert> : null}
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-start gap-2">
            <Mail className="mt-0.5 h-4 w-4 text-accent" />
            <div className="min-w-0 flex-1">
              <Field label="Daily digest e-mail" htmlFor={`${id}-digest`} hint={`One e-mail with everything still unread, on the clinic clock (${timezone}).`}>
                <Select
                  id={`${id}-digest`}
                  value={digestHour === null ? "" : String(digestHour)}
                  onChange={(e) => {
                    setDigestHour(e.target.value === "" ? null : Number(e.target.value));
                    setDirty(true);
                  }}
                  data-testid="pref-digest-hour"
                >
                  <option value="">No digest</option>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="outline" onClick={() => void sendTest()} disabled={testing} data-testid="pref-send-test">
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send me a test notification
        </Button>
        <div className="flex items-center gap-3">
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          <Button type="button" onClick={() => void save()} disabled={saving} data-testid="pref-save">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
            {saving ? "Saving…" : "Save preferences"}
          </Button>
        </div>
      </div>
    </div>
  );
}
