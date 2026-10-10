// The yellow-and-black crash-test target. Spins while the agent is working.
export default function Marker({ size = 16, spin = false }: { size?: number; spin?: boolean }): React.JSX.Element {
  return <span className={`marker ${spin ? 'spin' : ''}`} style={{ width: size, height: size }} aria-hidden />
}
