import { test as setup } from "@playwright/test";
import { signIn, OWNER_STATE } from "./helpers";

/** Signs in once per run; the browser projects reuse the stored session. */
setup("authenticate as the clinic owner", async ({ page }) => {
  await signIn(page);
  await page.context().storageState({ path: OWNER_STATE });
});
