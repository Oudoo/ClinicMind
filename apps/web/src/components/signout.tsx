"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="icon"
      title="Sign out"
      onClick={() => signOut({ callbackUrl: "/login" })}
    >
      <LogOut className="h-4 w-4" />
    </Button>
  );
}
