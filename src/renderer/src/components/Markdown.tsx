import { Fragment } from 'react'

// Just enough markdown for agent messages: **bold** and `code`. Everything else stays plain text.
export default function Markdown({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={i}>{part.slice(2, -2)}</strong>
        if (part.startsWith('`') && part.endsWith('`'))
          return <code key={i}>{part.slice(1, -1)}</code>
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}
