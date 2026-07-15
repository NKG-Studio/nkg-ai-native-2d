import { describe, expect, it } from 'vitest'
import { createFrameEditorState, frameEditorReducer, visibleFrameIds } from './editor'

describe('frameEditorReducer', () => {
  it('hydrates a saved snapshot without carrying history', () => {
    const state = frameEditorReducer(createFrameEditorState(), {
      type: 'hydrate',
      snapshot: { order: [2, 0, 1], hidden: [0], selected: [] },
    })
    expect(state.present).toEqual({ order: [2, 0, 1], hidden: [0], selected: [] })
    expect(state.past).toEqual([])
  })

  it('hides selected frames without destroying the original order and restores them', () => {
    let state = createFrameEditorState([0, 1, 2, 3])
    state = frameEditorReducer(state, { type: 'select', frameIds: [1, 2] })
    state = frameEditorReducer(state, { type: 'hide_selected' })
    expect(visibleFrameIds(state.present)).toEqual([0, 3])
    expect(state.present.order).toEqual([0, 1, 2, 3])
    state = frameEditorReducer(state, { type: 'restore_all' })
    expect(visibleFrameIds(state.present)).toEqual([0, 1, 2, 3])
  })

  it('moves a selected block one visible step and preserves hidden anchors', () => {
    let state = createFrameEditorState([0, 1, 2, 3, 4])
    state = frameEditorReducer(state, { type: 'select', frameIds: [1] })
    state = frameEditorReducer(state, { type: 'hide_selected' })
    state = frameEditorReducer(state, { type: 'select', frameIds: [3, 4] })
    state = frameEditorReducer(state, { type: 'move_selected', direction: -1 })
    expect(visibleFrameIds(state.present)).toEqual([0, 3, 4, 2])
    expect(state.present.hidden).toEqual([1])
  })

  it('supports undo and redo for destructive-looking edits', () => {
    let state = createFrameEditorState([0, 1, 2])
    state = frameEditorReducer(state, { type: 'select', frameIds: [1] })
    state = frameEditorReducer(state, { type: 'hide_selected' })
    expect(visibleFrameIds(state.present)).toEqual([0, 2])
    state = frameEditorReducer(state, { type: 'undo' })
    expect(visibleFrameIds(state.present)).toEqual([0, 1, 2])
    state = frameEditorReducer(state, { type: 'redo' })
    expect(visibleFrameIds(state.present)).toEqual([0, 2])
  })

  it('refuses to hide down to fewer than two frames', () => {
    let state = createFrameEditorState([0, 1, 2])
    state = frameEditorReducer(state, { type: 'select', frameIds: [0, 1] })
    const next = frameEditorReducer(state, { type: 'hide_selected' })
    expect(next).toBe(state)
  })
})
