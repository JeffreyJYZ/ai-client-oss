import type { Host } from "@lib/plugins/host";

/**
 * The shell area's built-in contributions (headers, notices, the default
 * layout). Empty seam: Task 6 (shell migration) fills it. Registering through
 * the `Host` — the same public API a plugin uses — is what keeps the tree
 * compiling while giving Task 6 a file no other task writes.
 */
export const registerShellBuiltins = (_host: Host): void => {};
