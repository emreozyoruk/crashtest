import { safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from './store'
import type { SecretName, SecretStatus } from '../shared/types'

// Secrets (API keys, tokens, SSH credentials, per-project .env values) are encrypted with
// the macOS Keychain-backed safeStorage and never sent to the renderer.

type SecretMap = Record<string, string>

const file = (): string => join(dataDir(), 'secrets.bin')

function readAll(): SecretMap {
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(file()))) as SecretMap
  } catch {
    return {}
  }
}

function writeAll(map: SecretMap): void {
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(map)))
}

export function getSecret(name: string): string | undefined {
  return readAll()[name] || undefined
}

export function setSecret(name: string, value: string): void {
  const map = readAll()
  if (value) map[name] = value
  else delete map[name]
  writeAll(map)
}

export function secretStatus(): SecretStatus {
  const map = readAll()
  const has = (k: SecretName): boolean => Boolean(map[k])
  return {
    anthropicKey: has('anthropicKey'),
    githubToken: has('githubToken'),
    sshPassword: has('sshPassword'),
    sshPrivateKey: has('sshPrivateKey')
  }
}

const envKey = (projectId: string): string => `env:${projectId}`

export function getProjectEnv(projectId: string): Record<string, string> {
  const raw = getSecret(envKey(projectId))
  return raw ? (JSON.parse(raw) as Record<string, string>) : {}
}

export function setProjectEnvVar(projectId: string, key: string, value: string): void {
  const env = getProjectEnv(projectId)
  env[key] = value
  setSecret(envKey(projectId), JSON.stringify(env))
}
