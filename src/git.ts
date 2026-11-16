import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, UserError } from './util.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function repoRoot(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new UserError(`Not inside a Git repository: ${cwd}. ProofLoop ties every result to a commit.`);
  }
}

export function resolveRef(root: string, ref: string): string {
  try {
    return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new UserError(`Unknown Git ref: ${ref}`);
  }
}

export function headCommit(root: string): string {
  try {
    return git(root, ['rev-parse', 'HEAD']);
  } catch {
    return 'no-commit';
  }
}

/** Hash of uncommitted tracked + untracked changes (excluding .proofloop control files). */
export function workingTreeState(root: string): { dirty: boolean; diffHash?: string } {
  const status = git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).proofloop']);
  if (!status) return { dirty: false };
  const diff = git(root, ['diff', 'HEAD', '--', '.', ':(exclude).proofloop']);
  return { dirty: true, diffHash: sha256(status + '\n' + diff).slice(0, 16) };
}

export function changedFiles(root: string, base: string): string[] {
  const committed = git(root, ['diff', '--name-only', `${base}`]).split('\n');
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...committed, ...untracked].filter(Boolean))];
}

export function addWorktree(root: string, commit: string, dir: string): void {
  if (existsSync(dir)) removeWorktree(root, dir);
  mkdirSync(join(dir, '..'), { recursive: true });
  git(root, ['worktree', 'add', '--detach', '--force', dir, commit]);
}

export function removeWorktree(root: string, dir: string): void {
  try {
    git(root, ['worktree', 'remove', '--force', dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      /* ignore */
    }
  }
}

export function commitsAfter(root: string, commit: string): string[] {
  try {
    const out = git(root, ['rev-list', `${commit}..HEAD`]);
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}
