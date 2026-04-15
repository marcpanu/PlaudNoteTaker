import { execSync } from "child_process";
import { existsSync } from "fs";

/**
 * Get the directory tree of the vault, excluding markdown files and hidden dirs.
 * Returns a string like:
 *   Work/Meetings
 *   Work/Notes
 *   Personal
 *   Health
 */
export function getVaultFolderTree(vaultPath: string): string {
  if (!existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }

  // Use find to list directories, excluding hidden dirs and .obsidian
  const output = execSync(
    `find . -type d -not -path '*/.*' -not -name '.' | sort`,
    { cwd: vaultPath, encoding: "utf-8" },
  );

  // Clean up: remove leading "./" and filter empties
  return output
    .split("\n")
    .map((line) => line.replace(/^\.\//, ""))
    .filter((line) => line.length > 0)
    .join("\n");
}
