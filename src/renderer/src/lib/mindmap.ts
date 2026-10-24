import type { Requirement } from './types'

// 节点高、同侧竖直间距、列间距、根节点尺寸、画布留白
const NODE_H = 34
const GAP_Y = 14
const COL_GAP = 56
const ROOT_W = 148
const ROOT_H = 46
const PAD = 40

export interface MapNode {
  req: Requirement
  depth: number
  children: MapNode[]
}

export interface LayoutOptions {
  // 收起的分支：slug 在这里的节点不再铺开子需求
  collapsed?: Set<string>
  // 搜索命中集合；给了就只留命中的节点与它们的祖先链
  hits?: Set<string> | null
}

export interface LaidNode {
  req: Requirement
  depth: number
  side: 'left' | 'right'
  x: number
  y: number
  width: number
  height: number
  // 收起时被藏起来的子需求数，0 表示没藏
  hidden: number
  // 还有子需求，可以收起
  collapsible: boolean
}

export interface LaidEdge {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  // 顶层分支的序号，用来取连线颜色
  branch: number
}

export interface MapLayout {
  root: { x: number; y: number; width: number; height: number }
  nodes: LaidNode[]
  edges: LaidEdge[]
  width: number
  height: number
}

// 按字数估宽：中文按 1em、ASCII 按 0.55em，再夹到 [132, 240]
export function nodeWidth(title: string): number {
  let units = 0
  for (const ch of title) units += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.55
  return Math.min(240, Math.max(132, Math.round(units * 12 + 46)))
}

/**
 * 按 slug 建树。
 *
 * slug 是权威：子需求就是需求目录里的需求目录，slug 形如 parent/child。
 * 库里那个 parent_id 也是扫描时按 slug 推出来的，所以这里不看它。
 * 中间层不是需求（alpha/gateway 是、alpha 不是）时挂到最近的存在祖先，
 * 一个都没有就当顶层——不合成虚节点，悬停提示里看得到完整 slug。
 */
export function buildTree(reqs: Requirement[]): MapNode[] {
  const bySlug = new Map<string, MapNode>()
  for (const req of reqs) bySlug.set(req.slug, { req, depth: 0, children: [] })

  const roots: MapNode[] = []
  for (const req of reqs) {
    const node = bySlug.get(req.slug)!
    const parent = nearestAncestor(req.slug, bySlug)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const setDepth = (node: MapNode, depth: number): void => {
    node.depth = depth
    for (const child of node.children) setDepth(child, depth + 1)
  }
  for (const root of roots) setDepth(root, 1)
  return roots
}

// 沿 slug 逐段往上去找最近的、确实存在的祖先
function nearestAncestor(slug: string, bySlug: Map<string, MapNode>): MapNode | null {
  let cut = slug.lastIndexOf('/')
  while (cut > 0) {
    const parent = bySlug.get(slug.slice(0, cut))
    if (parent) return parent
    cut = slug.lastIndexOf('/', cut - 1)
  }
  return null
}

// 搜索时只留命中的节点与它们的祖先链——否则树会断成一片
function filterByHits(nodes: MapNode[], hits: Set<string> | null): MapNode[] {
  if (!hits) return nodes
  const out: MapNode[] = []
  for (const node of nodes) {
    const children = filterByHits(node.children, hits)
    if (hits.has(node.req.slug) || children.length > 0) out.push({ ...node, children })
  }
  return out
}

/**
 * 左右分支布局。
 *
 * 顶层需求分两侧（前一半在左、其余在右，只有一条时放右），每一侧各自按
 * 「叶子槽位」排：叶子各占一格，父节点落在子节点跨度的中心——这样父节点一定
 * 落在自己那棵子树的跨度内，兄弟子树互不重叠，同层节点就不会叠。
 * 两侧各自竖直居中后，根落在这张图的共同中心。
 */
export function layoutTree(branches: MapNode[], opts: LayoutOptions = {}): MapLayout {
  const collapsed = opts.collapsed ?? new Set<string>()
  const hits = opts.hits ?? null
  const kept = filterByHits(branches, hits)

  const leftIdx: number[] = []
  const rightIdx: number[] = []
  kept.forEach((_, i) => {
    if (kept.length > 1 && i < Math.ceil(kept.length / 2)) leftIdx.push(i)
    else rightIdx.push(i)
  })

  const nodes: LaidNode[] = []
  const links: Array<{ parent: string | null; child: LaidNode; branch: number }> = []

  // 摆一侧，返回这一侧的总高；x 留到后面按列统一定
  const placeSide = (idxs: number[], side: 'left' | 'right'): number => {
    let cursor = 0
    const colWidth = new Map<number, number>()

    const walk = (node: MapNode, depth: number, branch: number, parent: string | null): number => {
      const width = nodeWidth(node.req.title)
      colWidth.set(depth, Math.max(colWidth.get(depth) ?? 0, width))
      // 搜索时无视收起：搜了就该看见命中在哪
      const hide = !hits && collapsed.has(node.req.slug)
      const kids = hide ? [] : node.children

      let center: number
      if (kids.length === 0) {
        center = cursor + NODE_H / 2
        cursor += NODE_H + GAP_Y
      } else {
        const centers = kids.map((k) => walk(k, depth + 1, branch, node.req.slug))
        center = (centers[0] + centers[centers.length - 1]) / 2
      }

      const laid: LaidNode = {
        req: node.req,
        depth,
        side,
        // 先只放 y，归一化之后 x、y 一起平移
        x: 0,
        y: center - NODE_H / 2,
        width,
        height: NODE_H,
        hidden: hide ? node.children.length : 0,
        collapsible: node.children.length > 0,
      }
      nodes.push(laid)
      links.push({ parent, child: laid, branch })
      return center
    }

    for (const i of idxs) walk(kept[i], 1, i, null)

    // 列位置：这一列靠根那一侧离根中心多远。列宽取该列最宽的节点
    const innerEdge = new Map<number, number>()
    let edge = ROOT_W / 2 + COL_GAP
    for (const depth of [...colWidth.keys()].sort((a, b) => a - b)) {
      innerEdge.set(depth, edge)
      edge += (colWidth.get(depth) ?? 0) + COL_GAP
    }

    for (const node of nodes) {
      if (node.side !== side) continue
      const inner = innerEdge.get(node.depth) ?? 0
      node.x = side === 'right' ? inner : -(inner + node.width)
    }

    return Math.max(0, cursor - GAP_Y)
  }

  const rightH = placeSide(rightIdx, 'right')
  const leftH = placeSide(leftIdx, 'left')
  const contentH = Math.max(rightH, leftH)

  // 两侧各自竖直居中，根这才落在共同中心上
  for (const node of nodes) {
    const ownH = node.side === 'right' ? rightH : leftH
    node.y += (contentH - ownH) / 2
  }

  // 归一化：把所有坐标平移到 [PAD, …]，顺带算出画布尺寸
  let minX = -ROOT_W / 2
  let maxX = ROOT_W / 2
  let minY = contentH / 2 - ROOT_H / 2
  let maxY = minY + ROOT_H
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x + node.width)
    minY = Math.min(minY, node.y)
    maxY = Math.max(maxY, node.y + node.height)
  }
  const dx = PAD - minX
  const dy = PAD - minY
  for (const node of nodes) {
    node.x += dx
    node.y += dy
  }
  const root = {
    x: -ROOT_W / 2 + dx,
    y: contentH / 2 - ROOT_H / 2 + dy,
    width: ROOT_W,
    height: ROOT_H,
  }

  const bySlug = new Map(nodes.map((node) => [node.req.slug, node]))
  const edges: LaidEdge[] = links.map(({ parent, child, branch }) => {
    const p = parent ? bySlug.get(parent)! : root
    const y1 = p.y + p.height / 2
    const y2 = child.y + child.height / 2
    return child.side === 'right'
      ? { id: child.req.slug, branch, x1: p.x + p.width, y1, x2: child.x, y2 }
      : { id: child.req.slug, branch, x1: p.x, y1, x2: child.x + child.width, y2 }
  })

  return {
    root,
    nodes,
    edges,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  }
}
