"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={signOut} disabled={pending} aria-label="Sign out">
      <LogOut className="h-4 w-4" />
      Sign out
    </Button>
  );
}
