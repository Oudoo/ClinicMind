import { expect, type Page } from "@playwright/test";

export const DEMO_EMAIL = process.env.E2E_EMAIL ?? "owner@demo.clinic";
export const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? "Demo-Clinic-2026!";
export const OWNER_STATE = "e2e/.auth/owner.json";
export const ANONYMOUS = { cookies: [], origins: [] };

export async function signIn(page: Page, email = DEMO_EMAIL, password = DEMO_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // Signing in loads the dashboard as a new document. Until its scripts run, a click on a menu
  // goes nowhere: on a live site that takes a second or so, on this machine no time at all.
  await page.waitForLoadState("load");
}
