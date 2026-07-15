export interface FrameEditorSnapshot {
  order: number[]
  hidden: number[]
  selected: number[]
}

export interface FrameEditorState {
  past: FrameEditorSnapshot[]
  present: FrameEditorSnapshot
  future: FrameEditorSnapshot[]
}

export type FrameEditorAction =
  | { type: 'reset'; frameIds: number[] }
  | { type: 'hydrate'; snapshot: FrameEditorSnapshot }
  | { type: 'toggle'; frameId: number; additive?: boolean }
  | { type: 'select'; frameIds: number[] }
  | { type: 'select_all_visible' }
  | { type: 'clear_selection' }
  | { type: 'hide_selected' }
  | { type: 'restore_all' }
  | { type: 'move_selected'; direction: -1 | 1 }
  | { type: 'undo' }
  | { type: 'redo' }

const HISTORY_LIMIT = 50

export function createFrameEditorState(frameIds: number[] = []): FrameEditorState {
  return {
    past: [],
    present: { order: [...frameIds], hidden: [], selected: [] },
    future: [],
  }
}

export function visibleFrameIds(snapshot: FrameEditorSnapshot): number[] {
  const hidden = new Set(snapshot.hidden)
  return snapshot.order.filter((frameId) => !hidden.has(frameId))
}

function sameArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function commit(state: FrameEditorState, next: FrameEditorSnapshot): FrameEditorState {
  if (
    sameArray(state.present.order, next.order)
    && sameArray(state.present.hidden, next.hidden)
    && sameArray(state.present.selected, next.selected)
  ) return state
  return {
    past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present],
    present: next,
    future: [],
  }
}

function moveSelected(snapshot: FrameEditorSnapshot, direction: -1 | 1): FrameEditorSnapshot {
  const selected = new Set(snapshot.selected)
  const hidden = new Set(snapshot.hidden)
  const order = [...snapshot.order]
  const visible = order.filter((frameId) => !hidden.has(frameId))

  if (direction < 0) {
    for (let index = 1; index < visible.length; index += 1) {
      const current = visible[index]!
      const previous = visible[index - 1]!
      if (selected.has(current) && !selected.has(previous)) {
        const currentOrderIndex = order.indexOf(current)
        const previousOrderIndex = order.indexOf(previous)
        ;[order[previousOrderIndex], order[currentOrderIndex]] = [current, previous]
        ;[visible[index - 1], visible[index]] = [current, previous]
      }
    }
  } else {
    for (let index = visible.length - 2; index >= 0; index -= 1) {
      const current = visible[index]!
      const next = visible[index + 1]!
      if (selected.has(current) && !selected.has(next)) {
        const currentOrderIndex = order.indexOf(current)
        const nextOrderIndex = order.indexOf(next)
        ;[order[currentOrderIndex], order[nextOrderIndex]] = [next, current]
        ;[visible[index], visible[index + 1]] = [next, current]
      }
    }
  }
  return { ...snapshot, order }
}

export function frameEditorReducer(state: FrameEditorState, action: FrameEditorAction): FrameEditorState {
  switch (action.type) {
    case 'reset':
      return createFrameEditorState(action.frameIds)
    case 'hydrate':
      return {
        past: [],
        present: {
          order: [...action.snapshot.order],
          hidden: [...action.snapshot.hidden],
          selected: [...action.snapshot.selected],
        },
        future: [],
      }
    case 'toggle': {
      const selected = new Set(action.additive ? state.present.selected : [])
      if (selected.has(action.frameId)) selected.delete(action.frameId)
      else selected.add(action.frameId)
      return { ...state, present: { ...state.present, selected: [...selected] } }
    }
    case 'select':
      return { ...state, present: { ...state.present, selected: [...new Set(action.frameIds)] } }
    case 'select_all_visible':
      return { ...state, present: { ...state.present, selected: visibleFrameIds(state.present) } }
    case 'clear_selection':
      return { ...state, present: { ...state.present, selected: [] } }
    case 'hide_selected': {
      if (state.present.selected.length === 0) return state
      const hidden = new Set([...state.present.hidden, ...state.present.selected])
      if (state.present.order.length - hidden.size < 2) return state
      return commit(state, { ...state.present, hidden: [...hidden], selected: [] })
    }
    case 'restore_all':
      return commit(state, { ...state.present, hidden: [], selected: [] })
    case 'move_selected':
      return commit(state, moveSelected(state.present, action.direction))
    case 'undo': {
      const previous = state.past[state.past.length - 1]
      if (!previous) return state
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (!next) return state
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
      }
    }
    default:
      return state
  }
}
