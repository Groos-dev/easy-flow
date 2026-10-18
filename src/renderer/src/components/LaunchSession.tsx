import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { LaunchAgent, LaunchProviderInfo, LaunchResult, Requirement, Worktree } from '../lib/types'
import LaunchSessionForm from './LaunchSessionForm'
import { launchNeedsWorktree, launchWorktreeSelection } from '../lib/launch'

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
  const requestSequence = useRef(0)

  useEffect(() => () => { requestSequence.current += 1 }, [])

  useEffect(() => {
    const selected = launchWorktreeSelection(worktrees, worktreeId).selectedId
    if (selected !== worktreeId) {
      requestSequence.current += 1
      setWorktreeId(selected)
      setBusy(false)
      setResult(null)
      setRequestError('')
    }
  }, [worktrees, worktreeId])

  useEffect(() => {
    if (!open || providersLoaded) return
    let alive = true
    setLoading(true)
    setProviderError('')
    void api.launchProviders()
      .then(({ providers: loaded }) => {
        if (!alive) return
        setProviders(loaded)
        // 默认选第一个：可用 agent 就两三个，选一次就够
        setAgent((current) => loaded.some((p) => p.id === current) ? current : (loaded[0]?.id ?? ''))
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
    if (!agent || busy) return
    // 有工作区就必须带一个：Claude 用它当 folder，Codex 用它当 path（app 按目录认项目）
    const needsWorktree = launchNeedsWorktree(launchWorktreeSelection(worktrees).available)
    if (needsWorktree && !worktreeId) return
    const sequence = ++requestSequence.current
    const selectedWorktreeId = needsWorktree ? worktreeId : ''
    const selectedAgent = agent
    setBusy(true)
    setResult(null)
    setRequestError('')
    try {
      const target = await api.launch({
        slug: req.slug,
        project: req.project,
        worktreeId: selectedWorktreeId,
        agent: selectedAgent,
      })
      if (sequence === requestSequence.current) setResult(target)
    } catch (error) {
      if (sequence === requestSequence.current) setRequestError((error as Error).message)
    } finally {
      if (sequence === requestSequence.current) setBusy(false)
    }
  }

  function changeWorktree(id: string) {
    requestSequence.current += 1
    setWorktreeId(id)
    setBusy(false)
    setResult(null)
    setRequestError('')
  }

  function changeAgent(id: LaunchAgent) {
    requestSequence.current += 1
    setAgent(id)
    setBusy(false)
    setResult(null)
    setRequestError('')
  }

  // 首次展开时 provider 列表还没到：别让表单先闪一句「没有可用的 Agent」
  const loadingProviders = loading || (open && !providersLoaded && !providerError)

  return (
    <div className="launch-session">
      {open ? (
        <div className="new-sess">
          <div className="new-sess-head">
            新建会话
            <span className="spacer" />
            <button className="new-sess-x" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          <LaunchSessionForm
            requirementId={req.id}
            worktrees={worktrees}
            providers={providers}
            worktreeId={worktreeId}
            agent={agent}
            loading={loadingProviders}
            providerError={providerError}
            requestError={requestError}
            busy={busy}
            result={result}
            onWorktreeChange={changeWorktree}
            onAgentChange={changeAgent}
            onLaunch={() => void launch()}
          />
        </div>
      ) : (
        // 收起态就是一行入口，样式沿用会话行（.add-sess）
        <button className="add-sess" onClick={() => setOpen(true)} aria-expanded={false}>
          ＋ 新建会话
        </button>
      )}
    </div>
  )
}
