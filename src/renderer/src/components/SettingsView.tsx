import { useEffect, useState } from 'react'
import type { SecretName, SecretStatus, Settings } from '../../../shared/types'

function SecretField(props: {
  name: SecretName
  label: string
  placeholder: string
  saved: boolean
  multiline?: boolean
  onSaved: (s: SecretStatus) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const save = async (v: string): Promise<void> => {
    props.onSaved(await window.api.setSecret(props.name, v))
    setValue('')
  }
  return (
    <div className="field">
      <label htmlFor={props.name}>
        {props.label} {props.saved && <span className="saved">● Saved in Keychain</span>}
      </label>
      <div className="field-row">
        {props.multiline ? (
          <textarea
            id={props.name}
            rows={3}
            value={value}
            placeholder={props.placeholder}
            onChange={(e) => setValue(e.target.value)}
            style={{
              flex: 1,
              padding: 8,
              border: '1px solid var(--line)',
              borderRadius: 4,
              fontFamily: 'var(--mono)',
              fontSize: 12
            }}
          />
        ) : (
          <input
            id={props.name}
            type="password"
            value={value}
            placeholder={props.saved ? 'Paste to replace' : props.placeholder}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
        )}
        <button className="btn" disabled={!value.trim()} onClick={() => void save(value.trim())}>
          Save
        </button>
        {props.saved && (
          <button className="btn ghost" onClick={() => void save('')}>
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

export default function SettingsView(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [secrets, setSecrets] = useState<SecretStatus | null>(null)
  const [vdsNote, setVdsNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void window.api.getSettings().then((r) => {
      setSettings(r.settings)
      setSecrets(r.secrets)
    })
  }, [])

  if (!settings || !secrets) return <div className="settings" />

  const update = (next: Settings): void => {
    setSettings(next)
    void window.api.saveSettings(next)
  }
  const ssh = settings.ssh
  const setSsh = (patch: Partial<Settings['ssh']>): void =>
    update({ ...settings, ssh: { ...ssh, ...patch } })

  const test = async (): Promise<void> => {
    setTesting(true)
    const problem = await window.api.testVds()
    setTesting(false)
    setVdsNote(
      problem
        ? { ok: false, text: problem }
        : { ok: true, text: `Connected to ${ssh.username}@${ssh.host}.` }
    )
  }

  return (
    <div className="settings">
      <div className="settings-inner">
        <h2>Settings</h2>

        <section>
          <h3>Model access</h3>
          <p className="hint">
            Crashtest runs on your own Anthropic key: Haiku writes scenarios, Sonnet reads code and
            runs them.
          </p>
          <SecretField
            name="anthropicKey"
            label="Anthropic API key"
            placeholder="sk-ant-…"
            saved={secrets.anthropicKey}
            onSaved={setSecrets}
          />
        </section>

        <section>
          <h3>GitHub</h3>
          <p className="hint">
            Public repos need nothing. For private repos, add a token that can read them.
          </p>
          <SecretField
            name="githubToken"
            label="Personal access token"
            placeholder="github_pat_…"
            saved={secrets.githubToken}
            onSaved={setSecrets}
          />
        </section>

        <section>
          <h3>Where scenarios run</h3>
          <div className="segmented" role="radiogroup" aria-label="Default run target">
            {(
              [
                ['ask', 'Ask every time'],
                ['local', 'This Mac'],
                ['vds', 'My server']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={settings.defaultRunTarget === value ? 'on' : ''}
                role="radio"
                aria-checked={settings.defaultRunTarget === value}
                onClick={() => update({ ...settings, defaultRunTarget: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Scenario runner</h3>
          <p className="hint">
            The model that runs each scenario. Sonnet judges more carefully; Haiku costs about a
            third as much.
          </p>
          <div className="segmented" role="radiogroup" aria-label="Scenario runner model">
            {(
              [
                ['sonnet', 'Sonnet'],
                ['haiku', 'Haiku']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={settings.runnerModel === value ? 'on' : ''}
                role="radio"
                aria-checked={settings.runnerModel === value}
                onClick={() => update({ ...settings, runnerModel: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Your server (VDS)</h3>
          <p className="hint">
            Crashtest connects over SSH, copies the repo there, starts the app and tunnels it back
            to a browser on this Mac.
          </p>
          <div className="grid-3">
            <div className="field">
              <label htmlFor="host">Host</label>
              <input
                id="host"
                value={ssh.host}
                placeholder="203.0.113.10"
                onChange={(e) => setSsh({ host: e.target.value.trim() })}
              />
            </div>
            <div className="field">
              <label htmlFor="port">Port</label>
              <input
                id="port"
                type="number"
                value={ssh.port}
                onChange={(e) => setSsh({ port: Number(e.target.value) || 22 })}
              />
            </div>
            <div className="field">
              <label htmlFor="user">Username</label>
              <input
                id="user"
                value={ssh.username}
                placeholder="ubuntu"
                onChange={(e) => setSsh({ username: e.target.value.trim() })}
              />
            </div>
          </div>
          <SecretField
            name="sshPassword"
            label="Password"
            placeholder="Server password"
            saved={secrets.sshPassword}
            onSaved={setSecrets}
          />
          <SecretField
            name="sshPrivateKey"
            label="Private key (instead of a password)"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            saved={secrets.sshPrivateKey}
            multiline
            onSaved={setSecrets}
          />
          <div className="field-row" style={{ alignItems: 'center' }}>
            <button className="btn" onClick={() => void test()} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {vdsNote && (
              <span className={`note ${vdsNote.ok ? 'good' : 'bad'}`}>{vdsNote.text}</span>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
