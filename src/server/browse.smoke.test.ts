import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDirectoriesCore } from "./browse.server";
import { ServerResultError } from "./result";

// The core is pure filesystem — no Mongo, no git subprocess. Each suite gets
// its own fixture root under os.tmpdir() and T4D_BROWSE_ROOT is pointed at it
// before the first call; the env var is restored afterwards so other suites
// (and any later real browse) are unaffected.
const ORIGINAL_ROOT = process.env.T4D_BROWSE_ROOT;

let root: string;
let outside: string;

// Helper asserts a listing attempt fails with exactly the given code. Extracted
// so every containment test reads as "requesting this must be forbidden", not
// as error-shape boilerplate.
async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => {
      throw new Error("expected a ServerResultError, but the call succeeded");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServerResultError);
  expect((err as ServerResultError).code).toBe(code);
}

beforeAll(async () => {
  // Root and its escaped sibling live side by side under a shared parent so
  // the sibling-prefix test has a real `/tmp/x/rootevil`-shaped collision.
  const parent = await mkdtemp(join(tmpdir(), "t4d-browse-"));
  root = join(parent, "root");
  outside = join(parent, "outside");
  // `root` and `outside` do not exist yet — create them and their descendants
  // in one recursive pass.
  await mkdir(join(root, "zeta"), { recursive: true });
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "repo-dir"), { recursive: true });
  await mkdir(join(root, ".hidden"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "file.txt"), "x");
  // isGitRepo via a `.git` DIRECTORY (the plain-repo case)…
  await mkdir(join(root, "repo-dir", ".git"));
  // …and via a `.git` FILE (the worktree/submodule case).
  await writeFile(join(root, "alpha", ".git"), "gitdir: /elsewhere");
  await mkdir(outside, { recursive: true });
  await mkdir(join(outside, "secret"), { recursive: true });
  // Symlink INSIDE the root pointing OUTSIDE it — the escape that a prefix
  // check before realpath would let through.
  await symlink(outside, join(root, "escape"));
  // A second root-shaped sibling (`rootevil`) for the prefix-collision test.
  await mkdir(join(parent, "rootevil"), { recursive: true });

  process.env.T4D_BROWSE_ROOT = root;
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env.T4D_BROWSE_ROOT;
  else process.env.T4D_BROWSE_ROOT = ORIGINAL_ROOT;
  // rm(root) would leave the parent and `outside` behind; removing the parent
  // cleans root, outside AND the rootevil sibling in one pass.
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("listDirectoriesCore", () => {
  it("lists only subdirectories of the root, sorted, skipping files, dotfiles and node_modules", async () => {
    const listing = await listDirectoriesCore({});
    // The escape symlink does NOT appear here: readdir reports it as a symlink
    // dirent and isDirectory() is false for it, so the "directories only" rule
    // keeps it out — it is only reachable by requesting it by path, which the
    // symlink-escape test pins as forbidden.
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "repo-dir", "zeta"]);
    // file.txt, .hidden and node_modules must not appear.
    expect(listing.entries.map((e) => e.name)).not.toContain("file.txt");
    expect(listing.entries.map((e) => e.name)).not.toContain(".hidden");
    expect(listing.entries.map((e) => e.name)).not.toContain("node_modules");
  });

  it("reports parent null at the root and non-null one level down", async () => {
    const atRoot = await listDirectoriesCore({});
    expect(atRoot.parent).toBeNull();

    const child = atRoot.entries.find((e) => e.name === "zeta")!;
    const oneDown = await listDirectoriesCore({ path: child.path });
    // The parent of <root>/zeta is <root> itself.
    expect(oneDown.parent).toBe(atRoot.path);
  });

  it("marks isGitRepo for a directory containing a .git directory", async () => {
    const listing = await listDirectoriesCore({});
    const repo = listing.entries.find((e) => e.name === "repo-dir")!;
    expect(repo.isGitRepo).toBe(true);
  });

  it("marks isGitRepo for a directory containing a .git file (the worktree case)", async () => {
    const listing = await listDirectoriesCore({});
    const repo = listing.entries.find((e) => e.name === "alpha")!;
    expect(repo.isGitRepo).toBe(true);
  });

  it("rejects .. traversal", async () => {
    await expectCode(listDirectoriesCore({ path: "../.." }), "forbidden");
  });

  it("rejects a symlink escape", async () => {
    // Reverting the containment check to run BEFORE realpath makes this test
    // fail: the raw string `resolve(root, "escape")` is inside the root, and
    // only realpath reveals the symlink lands outside it.
    await expectCode(listDirectoriesCore({ path: "escape" }), "forbidden");
  });

  it("rejects a sibling-prefix path", async () => {
    // With root = <parent>/root, the sibling <parent>/rootevil satisfies a bare
    // `startsWith(root)` but must be rejected by the separator-appended check.
    await expectCode(
      listDirectoriesCore({ path: join(root, "..", "rootevil") }),
      "forbidden",
    );
  });

  it("unknown path is not_found and a file path is not_a_directory", async () => {
    await expectCode(listDirectoriesCore({ path: "nope" }), "not_found");
    await expectCode(listDirectoriesCore({ path: "file.txt" }), "not_a_directory");
  });
});
