import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, openSync, closeSync, realpathSync } from "node:fs";
import { resolve, relative, join, isAbsolute, dirname, basename, sep } from "node:path";

const exec = promisify(execFile);
export interface Isolation { repo: string; base: string; directory: string; relativeCwd: string }
export interface Worktree { path: string; input?: string; output?: string }
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Pi workflow", "-c", "user.email=pi-workflow@localhost", "-c", "commit.gpgsign=false", "-c", "merge.gpgsign=false", ...args], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
}
async function noOperation(path: string): Promise<void> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (existsSync(await git(path, "rev-parse", "--path-format=absolute", "--git-path", name))) throw new Error(`Unfinished Git operation (${name}): ${path}. Resolve and commit/finish it explicitly.`);
  }
}
async function clean(path: string): Promise<void> {
  await noOperation(path);
  if (await git(path, "status", "--porcelain", "--untracked-files=all")) throw new Error(`Worktree must be clean: ${path}. Resolve and commit conflicts/changes explicitly.`);
  if ((await git(path, "ls-files", "--stage")).split("\n").some(line => line.startsWith("160000 "))) throw new Error("Isolated workflows do not support submodules");
}
export async function initialize(cwd: string, directory: string): Promise<Isolation> {
  cwd = realpathSync(cwd);
  const repo = realpathSync(await git(cwd, "rev-parse", "--show-toplevel"));
  directory = join(realpathSync(dirname(resolve(directory))), basename(directory));
  const inside = relative(repo, directory);
  if (!inside || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) throw new Error("Workflow storage must be outside the source repository");
  await clean(repo);
  return { repo, base: await git(repo, "rev-parse", "HEAD"), directory, relativeCwd: relative(repo, cwd) };
}
export async function prepare(isolation: Isolation, tree: Worktree, revisions: string[]): Promise<string> {
  mkdirSync(isolation.directory, { recursive: true });
  if (!existsSync(tree.path)) await git(isolation.repo, "worktree", "add", "--detach", tree.path, isolation.base);
  // Refuse an unrelated directory, or a branch checkout which could move a user branch.
  const common = await git(tree.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common !== await git(isolation.repo, "rev-parse", "--path-format=absolute", "--git-common-dir")) throw new Error(`Unexpected worktree: ${tree.path}`);
  if (await git(tree.path, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error(`Worktree must remain detached: ${tree.path}`);
  await clean(tree.path);
  for (const revision of revisions) await git(tree.path, "merge", "--no-edit", "--no-ff", revision);
  tree.input = await git(tree.path, "rev-parse", "HEAD");
  return join(tree.path, isolation.relativeCwd);
}
export async function capture(tree: Worktree): Promise<string> {
  if (!tree.input) throw new Error("Missing worktree input revision");
  await noOperation(tree.path);
  if (await git(tree.path, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error(`Worktree must remain detached: ${tree.path}`);
  await git(tree.path, "merge-base", "--is-ancestor", tree.input, "HEAD");
  await git(tree.path, "add", "-A");
  const head = await git(tree.path, "rev-parse", "HEAD");
  const treeId = await git(tree.path, "write-tree");
  if (treeId !== await git(tree.path, "rev-parse", "HEAD^{tree}")) {
    const commit = await git(tree.path, "commit-tree", treeId, "-p", head, "-m", "Capture workflow step");
    await git(tree.path, "update-ref", "HEAD", commit, head);
  }
  await clean(tree.path);
  return tree.output = await git(tree.path, "rev-parse", "HEAD");
}
/** Logs stay on disk; timeout/cancel terminates the validation process group on POSIX. */
export function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export async function validate(tree: Worktree, cwd: string, command: string, signal: AbortSignal, started?: (pid: number) => void): Promise<void> {
  if (process.platform === "win32") throw new Error("Isolated workflow validation currently requires POSIX process groups");
  signal.throwIfAborted();
  const fd = openSync(`${tree.path}.validation.log`, "w", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", fd, fd] });
      let stopped = false;
      let startupError: unknown;
      const kill = () => { stopped = true; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") reject(e); } } };
      const timer = setTimeout(kill, 600_000);
      signal.addEventListener("abort", kill, { once: true });
      try { if (child.pid) started?.(child.pid); } catch (e) { startupError = e; kill(); }
      if (signal.aborted) kill();
      const done = (error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", kill); if (error) reject(error); };
      child.once("error", e => done(e));
      child.once("close", code => {
        const failed = stopped || signal.aborted || code !== 0;
        kill(); done();
        void (async () => {
          for (let i = 0; child.pid && groupAlive(child.pid) && i < 100; i++) await new Promise(r => setTimeout(r, 10));
          if (child.pid && groupAlive(child.pid)) throw new Error(`Validation process group ${child.pid} shutdown unconfirmed; inspect manually`);
          if (startupError) throw startupError;
          if (failed) throw new Error(`Validation failed/stopped (exit ${code}); log: ${tree.path}.validation.log`);
        })().then(resolve, reject);
      });
    });
  } finally { closeSync(fd); }
  await clean(tree.path);
  if (await git(tree.path, "rev-parse", "HEAD") !== tree.input || await git(tree.path, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error("Validation changed the candidate revision/branch; inspect the preserved worktree");
}
