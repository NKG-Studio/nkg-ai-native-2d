import { describe, expect, it } from 'vitest'
import { createMaskEditorState, maskEditorReducer, pointInContainedImage, type MaskStroke } from './mask'

const stroke: MaskStroke = {
  mode: 'remove',
  size: 24,
  points: [{ x: -1, y: 0.5 }, { x: 1.5, y: 0.8 }],
}

describe('maskEditorReducer', () => {
  it('hydrates and normalizes persisted masks', () => {
    const state = maskEditorReducer(createMaskEditorState(), {
      type: 'hydrate',
      masks: { 3: [{ ...stroke, points: [{ x: -2, y: 4 }] }] },
    })
    expect(state.present[3]![0]!.points).toEqual([{ x: 0, y: 1 }])
    expect(state.past).toEqual([])
  })

  it('commits normalized strokes and supports undo/redo', () => {
    const initial = createMaskEditorState()
    const committed = maskEditorReducer(initial, { type: 'commit', frameId: 7, stroke })
    expect(committed.present[7]![0]!.points).toEqual([{ x: 0, y: 0.5 }, { x: 1, y: 0.8 }])
    const undone = maskEditorReducer(committed, { type: 'undo' })
    expect(undone.present[7]).toBeUndefined()
    expect(maskEditorReducer(undone, { type: 'redo' }).present[7]).toHaveLength(1)
  })

  it('copies corrections to neighboring frames without sharing point objects', () => {
    const committed = maskEditorReducer(createMaskEditorState(), { type: 'commit', frameId: 7, stroke })
    const copied = maskEditorReducer(committed, { type: 'copy_to', sourceFrameId: 7, targetFrameIds: [6, 8] })
    expect(Object.keys(copied.present).sort()).toEqual(['6', '7', '8'])
    expect(copied.present[6]).toEqual(copied.present[7])
    expect(copied.present[6]).not.toBe(copied.present[7])
    expect(copied.present[6]![0]!.points[0]).not.toBe(copied.present[7]![0]!.points[0])
  })

  it('clears only the active frame and ignores empty commits', () => {
    const committed = maskEditorReducer(createMaskEditorState(), { type: 'commit', frameId: 7, stroke })
    const ignored = maskEditorReducer(committed, {
      type: 'commit',
      frameId: 8,
      stroke: { ...stroke, points: [] },
    })
    expect(ignored).toBe(committed)
    expect(maskEditorReducer(ignored, { type: 'clear_frame', frameId: 7 }).present).toEqual({})
  })
})

describe('pointInContainedImage', () => {
  it('maps pointer coordinates through horizontal letterboxing', () => {
    const point = pointInContainedImage(
      { left: 10, top: 20, width: 400, height: 200 },
      100,
      100,
      210,
      120,
    )
    expect(point).toEqual({ x: 0.5, y: 0.5 })
    expect(pointInContainedImage(
      { left: 10, top: 20, width: 400, height: 200 },
      100,
      100,
      50,
      120,
    )).toBeNull()
  })

  it('maps pointer coordinates through vertical letterboxing', () => {
    expect(pointInContainedImage(
      { left: 0, top: 0, width: 200, height: 400 },
      200,
      100,
      100,
      200,
    )).toEqual({ x: 0.5, y: 0.5 })
  })
})
