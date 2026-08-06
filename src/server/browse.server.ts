import { realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { ServerResultError } from "./result";

// A board's repoPath is a hand-typed absolute host path, and a workspace-write
// AI agent is later spawned against it (supervisor.server.ts dispatchRun), so
// browsing the filesystem is a read surface over the same trust boundary that
// dispatch already writes across. It is confined to a single browse root so it
// can never be used to enumerate the whole disk; the root is configurable for
// tests but defaults to the operator's home directory.

export type DirEntry = { name: string; path: string; isGitRepo: boolean };
export type DirListing = {
  path: string; // the resolved directory being listed
  parent: string | null; // null when `path` IS the browse root — never escape upward
  entries: DirEntry[]; // subdirectories only, sorted by name
};

// Resolved once per process, cached as a promise the way db() caches its
// connect promise: realpath collapses symlinks and trailing slashes so every
// containment comparison is against one canonical value, and reading the env
// var lazily lets tests point the root at a fixture tree before the first call.
let rootPromise: Promise<string> | null = null;
function browseRoot(): Promise<string> {
  if (!rootPromise) {
    const raw = process.env.T4D_BROWSE_ROOT ?? homedir();
    rootPromise = realpath(raw).catch((err) => {
      // A missing browse root is a configuration error; forget the attempt so
      // a later call can retry with a corrected env var instead of failing
      // forever on the rejected promise.
      rootPromise = null;
      throw err;
    });
  }
  return rootPromise;
}

// The containment check. Resolve the requested path against the root, then
// realpath the RESULT so `..` segments and any symlink on the path are
// collapsed to a real location before the boundary is judged. Comparing with
// the separator appended (`real === root || real.startsWith(root + sep)`) keeps
// a sibling like `/home/radan-evil` out when the root is `/home/radan`. A
// prefix check on the RAW input — before resolution — would be defeated by a
// symlink inside the root pointing outside it; the tests pin this ordering.
async function resolveInsideRoot(requested: string, root: string): Promise<string> {
  const joined = resolve(root, requested);
  let real: string;
  try {
    real = await realpath(joined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: the requested path does not exist. EACCES/EPERM: a segment on
    // the way cannot be traversed, which is as unreachable as not existing.
    if (code === "ENOENT") {
      throw new ServerResultError("not_found", "path does not exist");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ServerResultError("forbidden", "path is not accessible");
    }
    throw err;
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ServerResultError("forbidden", "path is outside the browsable root");
  }
  return real;
}

export async function listDirectoriesCore(input: {
  path?: string;
}): Promise<DirListing> {
  const root = await browseRoot();
  const requested = input.path ?? "";

  const target = await resolveInsideRoot(requested, root);

  // Confirm the resolved target is a directory, not a file — readdir would
  // otherwise throw ENOTDIR and surface as an opaque internal error.
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) {
    throw new ServerResultError("not_a_directory", "path is not a directory");
  }

  const dirents = await readdir(target, { withFileTypes: true });
  const dirs = dirents
    .filter((d) => d.isDirectory())
    // Hidden directories are noise here (`.git`, `.cache`, `.config` would
    // dominate the list) and node_modules is never a repo root an operator
    // wants to point a board at, so both are skipped. `.git` detection still
    // applies to the entries that remain.
    .filter((d) => !d.name.startsWith(".") && d.name !== "node_modules")
    .sort((a, b) => a.name.localeCompare(b.name));

  // Probe each candidate for `.git` independently. An unreadable subdirectory
  // (EACCES) must not fail the whole listing — one locked folder should not
  // make its parent unbrowsable — so any failure degrades to `isGitRepo: false`
  // rather than aborting. `stat`, not `access`: in a git worktree or submodule
  // `.git` is a FILE containing a gitdir pointer, and worktrees are exactly
  // what this app creates, so ANY existing `.git` counts regardless of type.
  const entries = await Promise.all(
    dirs.map(async (d) => {
      const dirPath = resolve(target, d.name);
      let isGitRepo = false;
      try {
        await stat(resolve(dirPath, ".git"));
        isGitRepo = true;
      } catch {
        // No `.git` at all, or no permission to see it — not a repo.
      }
      return { name: d.name, path: dirPath, isGitRepo };
    }),
  );

  // dirname of a resolved child is still inside the root by construction, so
  // no second containment pass is needed; the root itself has no parent.
  const parent = target === root ? null : dirname(target);

  return { path: target, parent, entries };
}
