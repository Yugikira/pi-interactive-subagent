/**
 * Shell quoting shared by the Herdr adapter and the runner launch plans.
 *
 * This is a leaf module: `herdr.ts` and `runners/*` both import it, and it
 * imports neither. Windows PowerShell accepts doubled single quotes inside a
 * single-quoted string; POSIX shells use the `'\''` idiom.
 */
export function shellEscape(s: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
