import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { LaunchAgent, LaunchProviderInfo, LaunchResult, Requirement, Worktree } from '../lib/types'
import LaunchSessionForm from './LaunchSessionForm'
import { launchWorktreeSelection } from '../lib/launch'

export default function LaunchSession({ req, worktrees }: { req: Requirement; worktrees: Worktree[] }) {
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<LaunchProviderInfo[]>([])
  const [providersLoaded, setProvidersLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [providerError, setProviderError] = useState('')
  const [worktreeId, setWorktreeId] = useState(() => launchWorktreeSelection(worktrees).selectedId)
  const [agent, setAgent] = useState<LaunchAgent | ''>('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LaunchResult | null>(null)
  const [requestError, setRequestError] = useState('')

  useEffect(() => {
    setWorktreeId((current) => launchWorktreeSelection(worktrees, current).selectedId)
  }, [worktrees])

  useEffect(() => {
    if (!open || providersLoaded) return
    let alive = true
    setLoading(true)
    setProviderError('')
    void api.launchProviders()
      .then(({ providers: loaded }) => {
        if (!alive) return
        setProviders(loaded)
        setAgent((current) => loaded.some((p) => p.id === current)
          ? current
          : loaded.length === 1 ? loaded[0].id : '')
        setProvidersLoaded(true)
      })
      .catch((error: Error) => {
        if (alive) setProviderError(error.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [open, providersLoaded])

  async function launch() {
    if (!worktreeId || !agent || busy) return
    setBusy(true)
    setResult(null)
    setRequestError('')
    try {
      setResult(await api.launch({
        slug: req.slug,
        project: req.project,
        worktreeId,
        agent,
      }))
    } catch (error) {
      setRequestError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="launch-session">
      <button className="btn launch-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? '收起启动入口' : '新建 Agent 会话'}
      </button>
      {open && (
        <LaunchSessionForm
          requirementId={req.id}
          worktrees={worktrees}
          providers={providers}
          worktreeId={worktreeId}
          agent={agent}
          loading={loading}
          providerError={providerError}
          requestError={requestError}
          busy={busy}
          result={result}
          onWorktreeChange={(id) => { setWorktreeId(id); setResult(null) }}
          onAgentChange={(id) => { setAgent(id); setResult(null) }}
          onLaunch={() => void launch()}
        />
      )}
    </div>
  )
}
