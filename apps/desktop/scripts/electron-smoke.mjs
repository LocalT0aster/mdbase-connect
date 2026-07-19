import { _electron as electron } from "playwright-core";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const executable = resolve(
  repoRoot,
  `target/debug/mdbase-connect-agent${process.platform === "win32" ? ".exe" : ""}`
);
const userData = process.env.MDBASE_CONNECT_SMOKE_DATA;
if (!userData) throw new Error("MDBASE_CONNECT_SMOKE_DATA is required");

const electronApp = await electron.launch({
  cwd: desktopRoot,
  args: [".", `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    MDBASE_CONNECT_AGENT_BIN: executable
  }
});

try {
  const window = await electronApp.firstWindow();
  await window.getByRole("heading", { name: "Your local connection." }).waitFor();
  await window.getByText("Local only").first().waitFor();
  await window.getByRole("button", { name: /Collections/ }).click();
  await window.getByRole("heading", { name: "Your files stay here." }).waitFor();
  await window.getByRole("button", { name: /App access/ }).click();
  await window.getByRole("heading", { name: "Connect this computer." }).waitFor();
  await window.getByRole("button", { name: /Overview/ }).click();
  const title = await window.title();
  if (title !== "MDBASE Connect") throw new Error(`Unexpected window title: ${title}`);
  const screenshot = process.env.MDBASE_CONNECT_SMOKE_SCREENSHOT;
  if (screenshot) await window.screenshot({ path: screenshot, animations: "disabled" });
  process.stdout.write("Electron smoke test passed\n");
} finally {
  await electronApp.close();
}
