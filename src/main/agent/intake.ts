import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join, relative } from 'path'
import { getSecret } from '../secrets'
import { workspacesDir } from '../store'

const exec = promisify(execFile)

export interface RepoRef {
  owner: string
  repo: string
  url: string
}

export function parseGithubUrl(text: string): RepoRef | undefined {
  const m = text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#\s]|$)/i)
  if (!m) return undefined
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` }
}

export function workdirFor(ref: RepoRef): string {
  return join(workspacesDir(), `${ref.owner}-${ref.repo}`)
}

export async function cloneRepo(ref: RepoRef): Promise<string> {
  const dir = workdirFor(ref)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  const token = getSecret('githubToken')
  const remote = token
    ? `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`
    : `${ref.url}.git`
  try {
    await exec('git', ['clone', '--depth', '1', remote, dir], { timeout: 180_000 })
  } catch (err) {
    // Never surface the token-bearing remote in an error message.
    const msg = String((err as Error).message).replaceAll(token ?? '\u0000', '***')
    if (/not found|could not read|Authentication failed/i.test(msg)) {
      throw new Error(
        token
          ? `Could not clone ${ref.url}. Check that your GitHub token can read this repository.`
          : `Could not clone ${ref.url}. If it is private, add a GitHub token in Settings.`
      )
    }
    throw new Error(`Could not clone ${ref.url}: ${msg.split('\n').slice(-2).join(' ')}`)
  }
  return dir
}

// --- Monorepo detection: workspace config first, then compose services, then manifests. ---

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'composer.json']
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv', 'vendor', 'target', 'docs', 'examples', 'test', 'tests'])

const hasManifest = (dir: string): boolean => MANIFESTS.some((m) => existsSync(join(dir, m)))

function expandGlob(root: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, '').replace(/\/\*\*?$/, '/*')
  if (!clean.endsWith('/*')) return existsSync(join(root, clean)) ? [join(root, clean)] : []
  const base = join(root, clean.slice(0, -2))
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map((d) => join(base, d))
    .filter((d) => statSync(d).isDirectory())
}

function workspaceDirs(root: string): string[] {
  const patterns: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages
    if (Array.isArray(ws)) patterns.push(...ws)
  } catch {
    /* no package.json */
  }
  try {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    patterns.push(...[...yaml.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?/gm)].map((m) => m[1]))
  } catch {
    /* no pnpm workspace */
  }
  return patterns.filter((p) => !p.startsWith('!')).flatMap((p) => expandGlob(root, p)).filter(hasManifest)
}

function composeDirs(root: string): string[] {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((f) => existsSync(join(root, f)))
  if (!file) return []
  const text = readFileSync(join(root, file), 'utf8')
  return [...text.matchAll(/^\s+(?:build:\s*|context:\s*)['"]?(\.[^'"\s]*)/gm)]
    .map((m) => join(root, m[1]))
    .filter((d) => d !== root && existsSync(d))
}

function manifestDirs(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 3) return acc
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    if (hasManifest(dir)) acc.push(dir)
    else manifestDirs(dir, depth + 1, acc)
  }
  return acc
}

// Returns product directories relative to the repo root; empty means "treat as one app".
export function detectProducts(root: string): string[] {
  for (const finder of [workspaceDirs, composeDirs, manifestDirs]) {
    const dirs = [...new Set(finder(root))]
    if (dirs.length > 1) return dirs.map((d) => relative(root, d)).sort()
  }
  return []
}
