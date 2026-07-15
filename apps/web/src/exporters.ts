import type { SpriteFrameManifest, SpriteSheetManifest } from './sprite'

export type ExportPreset = 'generic' | 'aseprite' | 'godot' | 'unity'

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000
const quote = (value: string) => JSON.stringify(value)

export function createAsepriteManifest(manifest: SpriteSheetManifest) {
  const frames = Object.fromEntries(manifest.frames.map((item) => [item.filename, {
    frame: item.frame,
    rotated: item.rotated,
    trimmed: item.trimmed,
    spriteSourceSize: item.spriteSourceSize,
    sourceSize: item.sourceSize,
    duration: item.duration,
  }]))
  const first = manifest.frames[0]
  return {
    frames,
    meta: {
      app: 'FrameLoop Studio',
      version: String(manifest.version),
      image: manifest.image,
      format: 'RGBA8888',
      size: { w: manifest.sheetSize.width, h: manifest.sheetSize.height },
      scale: '1',
      frameTags: [{
        name: manifest.animation.name,
        from: 0,
        to: Math.max(0, manifest.frames.length - 1),
        direction: 'forward',
      }],
      slices: first ? [{
        name: 'pivot',
        color: '#c7f36a',
        keys: manifest.frames.map((item) => ({
          frame: item.index,
          bounds: { x: 0, y: 0, w: item.sourceSize.w, h: item.sourceSize.h },
          pivot: {
            x: Math.round(item.pivot.x * item.sourceSize.w),
            y: Math.round(item.pivot.y * item.sourceSize.h),
          },
        })),
      }] : [],
    },
  }
}

function godotFrameResource(frame: SpriteFrameManifest) {
  const missingWidth = Math.max(0, frame.sourceSize.w - frame.spriteSourceSize.w)
  const missingHeight = Math.max(0, frame.sourceSize.h - frame.spriteSourceSize.h)
  const id = `AtlasTexture_${String(frame.index).padStart(3, '0')}`
  return {
    id,
    text: `[sub_resource type="AtlasTexture" id="${id}"]\n` +
      'atlas = ExtResource("1_sheet")\n' +
      `region = Rect2(${frame.frame.x}, ${frame.frame.y}, ${frame.frame.w}, ${frame.frame.h})\n` +
      `margin = Rect2(${frame.spriteSourceSize.x}, ${frame.spriteSourceSize.y}, ${missingWidth}, ${missingHeight})\n` +
      'filter_clip = true',
  }
}

export function createGodotSpriteFrames(manifest: SpriteSheetManifest) {
  const resources = manifest.frames.map(godotFrameResource)
  const frames = manifest.frames.map((frame, index) => `{
"duration": ${frame.duration},
"texture": SubResource("${resources[index]!.id}")
}`).join(', ')
  return `[gd_resource type="SpriteFrames" load_steps=${resources.length + 2} format=3]\n\n` +
    `[ext_resource type="Texture2D" path="res://${manifest.image}" id="1_sheet"]\n\n` +
    `${resources.map((resource) => resource.text).join('\n\n')}\n\n` +
    `[resource]\nanimations = [{\n` +
    `"frames": [${frames}],\n` +
    '"loop": true,\n' +
    `"name": &${quote(manifest.animation.name)},\n` +
    '"speed": 1000.0\n' +
    '}]\n'
}

export function createUnityManifest(manifest: SpriteSheetManifest, pixelsPerUnit = 100) {
  return {
    format: 'frameloop-unity-sprite-v1',
    image: manifest.image,
    animation: manifest.animation,
    pixelsPerUnit: Math.max(1, Math.round(pixelsPerUnit)),
    coordinateSystem: 'bottom-left',
    frames: manifest.frames.map((item) => {
      const sourcePivotX = item.pivot.x * item.sourceSize.w
      const sourcePivotY = item.pivot.y * item.sourceSize.h
      return {
        name: item.filename,
        sourceFrameId: item.sourceFrameId,
        rect: {
          x: item.frame.x,
          y: manifest.sheetSize.height - item.frame.y - item.frame.h,
          w: item.frame.w,
          h: item.frame.h,
        },
        pivot: {
          x: round((sourcePivotX - item.spriteSourceSize.x) / item.spriteSourceSize.w),
          y: round(1 - (sourcePivotY - item.spriteSourceSize.y) / item.spriteSourceSize.h),
        },
        duration: item.duration,
        sourceSize: item.sourceSize,
        spriteSourceSize: item.spriteSourceSize,
        empty: item.empty,
      }
    }),
  }
}
