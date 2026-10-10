import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, Project } from '../../../shared/types'
import { isWorking } from '../working'
import Markdown from './Markdown'
import Marker from './Marker'

type Block =
  { kind: 'message'; message: ChatMessage } | { kind: 'activity'; id: string; lines: string[] }

// Consecutive tool-activity lines collapse into one quiet block between real messages.
function toBlocks(messages: ChatMessage[]): Block[] {
  const blocks: Block[] = []
  for (const m of messages) {
    const last = blocks[blocks.length - 1]
    if (m.role === 'activity') {
      if (last?.kind === 'activity') last.lines.push(m.text)
      else blocks.push({ kind: 'activity', id: m.id, lines: [m.text] })
    } else blocks.push({ kind: 'message', message: m })
  }
  return blocks
}

function ActivityBlock({ lines, live }: { lines: string[]; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const shown = open ? lines : lines.slice(-4)
  return (
    <div className="activity-run">
      {lines.length > 4 && (
        <button className="more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all ${lines.length} steps`}
        </button>
      )}
      {shown.map((line, i) => (
        <div className="line" key={i}>
          {line}
        </div>
      ))}
      {live && <div className="line">…</div>}
    </div>
  )
}

function Empty(): React.JSX.Element {
  return (
    <div className="empty">
      <Marker size={44} />
      <h2>Find the bugs your users would hit, before they hit them.</h2>
      <p>
        Paste a GitHub link. Crashtest reads the code, writes every scenario a user can walk
        through, then runs them in a real browser.
      </p>
      <ol className="steps">
        <li>Maps every screen, action, API and rule from the code</li>
        <li>Writes the scenarios, ranked P1 to P3</li>
        <li>Boots the app on this Mac or your server and runs them</li>
      </ol>
    </div>
  )
}

export default function ChatView({
  project,
  onCreated
}: {
  project?: Project
  onCreated: (id: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const working = isWorking(project)
  const blocks = project ? toBlocks(project.messages) : []

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [project?.messages.length])

  const send = async (): Promise<void> => {
    const value = text.trim()
    if (!value || sending) return
    setSending(true)
    setError('')
    const res = await window.api.send(project?.id ?? null, value)
    setSending(false)
    if (res.error) return setError(res.error)
    setText('')
    if (!project && res.projectId) onCreated(res.projectId)
  }

  return (
    <div className="chat">
      {project ? (
        <div className="messages" ref={scroller}>
          <div className="messages-inner">
            {blocks.map((block, i) =>
              block.kind === 'activity' ? (
                <ActivityBlock
                  key={block.id}
                  lines={block.lines}
                  live={working && i === blocks.length - 1}
                />
              ) : (
                <div key={block.message.id} className={`msg ${block.message.role}`}>
                  <Markdown text={block.message.text} />
                  {block.message.actions && (
                    <div className="actions">
                      {block.message.actions.map((a) => (
                        <button
                          key={a.id}
                          className={`btn ${block.message.chosenActionId === a.id ? 'chosen' : ''}`}
                          disabled={Boolean(block.message.chosenActionId)}
                          onClick={() =>
                            void window.api.chooseAction(project.id, block.message.id, a.id)
                          }
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}
            {working && (
              <div className="working">
                <Marker size={14} spin />
                Working
                <button
                  className="btn ghost"
                  style={{ marginLeft: 8, padding: '2px 10px' }}
                  onClick={() => void window.api.stopRun(project.id)}
                >
                  Stop
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <Empty />
      )}
      {error && <div className="error-line">{error}</div>}
      <div className="composer">
        <div className="composer-inner">
          <textarea
            value={text}
            placeholder={
              project
                ? 'Ask about this app, share .env values or server details…'
                : 'https://github.com/owner/repo'
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            aria-label="Message"
          />
          <button
            className="btn primary"
            onClick={() => void send()}
            disabled={!text.trim() || sending}
          >
            {project ? 'Send' : 'Map this repo'}
          </button>
        </div>
      </div>
    </div>
  )
}
