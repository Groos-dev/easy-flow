import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import type { Todo } from '../lib/types'
import { TODO_STATUS_LABEL } from '../lib/types'

function label(status: string): string {
  return TODO_STATUS_LABEL[status] ?? status
}

interface CardProps {
  todo: Todo
  onOpen: (id: string) => void
  overlay?: boolean
}

function TodoCard({ todo, onOpen, overlay = false }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: todo.id,
    data: { type: 'todo', status: todo.status },
    disabled: overlay,
  })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined
  const who = todo.origin || todo.chat

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card${isDragging ? ' dragging' : ''}`}
      onClick={() => !overlay && onOpen(todo.id)}
      {...listeners}
      {...attributes}
    >
      <div className="card-top">
        <span className="card-title">{todo.title}</span>
      </div>
      <div className="card-slug">{todo.id}</div>
      {todo.summary && <div className="card-summary">{todo.summary}</div>}
      <div className="card-foot">
        {todo.source && <span className="chip">{todo.source}</span>}
        {who && <span className="chip">{who}</span>}
        {todo.missing && <span className="chip warn">md 已失联</span>}
        <span className="stage">{todo.updated.slice(5)}</span>
      </div>
    </div>
  )
}

interface ColumnProps {
  status: string
  items: Todo[]
  onOpen: (id: string) => void
  isOver: boolean
}

function ColumnView({ status, items, onOpen, isOver }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id: status, data: { status } })
  return (
    <div ref={setNodeRef} className={`column${isOver ? ' over' : ''}`}>
      <div className="column-head">
        <span>{label(status)}</span>
        <span className="n">{items.length}</span>
      </div>
      <div className="column-body">
        {items.length === 0 ? (
          <div className="empty">—</div>
        ) : (
          items.map((t) => <TodoCard key={t.id} todo={t} onOpen={onOpen} />)
        )}
      </div>
    </div>
  )
}

/** dnd-kit 的 data 是 unknown，这里收窄一次 */
function statusOf(over: DragOverEvent['over']): string | undefined {
  return (over?.data.current as { status?: string } | undefined)?.status
}

interface Props {
  todos: Todo[]
  /** 看板列顺序，由服务端下发 */
  statuses: string[]
  onOpen: (id: string) => void
  /** 拖到别的列：由 App 落库（乐观更新与回滚都在那边） */
  onMove: (id: string, status: string) => void
}

export default function TodoBoard({ todos, statuses, onOpen, onMove }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStatus, setOverStatus] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const byStatus = useMemo(() => {
    const map = new Map<string, Todo[]>(statuses.map((s) => [s, []]))
    for (const t of todos) {
      if (!map.has(t.status)) map.set(t.status, [])
      map.get(t.status)!.push(t)
    }
    return map
  }, [todos, statuses])

  const dragItem = todos.find((t) => t.id === dragId) ?? null

  function handleDragEnd({ active, over }: DragEndEvent) {
    setDragId(null)
    setOverStatus(null)
    if (!over) return
    const id = String(active.id)
    const target = statusOf(over) ?? String(over.id)
    const todo = todos.find((t) => t.id === id)
    if (todo && todo.status !== target) onMove(id, target)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({ active }) => setDragId(String(active.id))}
      onDragOver={({ over }) => setOverStatus(statusOf(over) ?? null)}
      onDragEnd={handleDragEnd}
    >
      <div className="board">
        {statuses.map((status) => (
          <ColumnView
            key={status}
            status={status}
            items={byStatus.get(status) ?? []}
            onOpen={onOpen}
            isOver={overStatus === status}
          />
        ))}
      </div>
      <DragOverlay>{dragItem ? <TodoCard todo={dragItem} onOpen={() => {}} overlay /> : null}</DragOverlay>
    </DndContext>
  )
}
