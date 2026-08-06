import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { server } from './index.js'

const temporaryDirectories: string[] = []
const client = new Client({ name: 'frameloop-test-client', version: '1.0.0' })

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterAll(async () => {
  await client.close()
  await server.close()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('sprite layout MCP workflow', () => {
  it('exposes images for an external multimodal agent and executes its polygon decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameloop-layout-mcp-'))
    temporaryDirectories.push(root)
    const atlasPath = join(root, 'atlas.png')
    const pixels = Buffer.alloc(16 * 12 * 4)
    for (let y = 2; y < 9; y += 1) {
      for (let x = 2; x < 11 - y / 2; x += 1) {
        const offset = (y * 16 + x) * 4
        pixels[offset] = 255
        pixels[offset + 3] = 255
      }
    }
    await sharp(pixels, { raw: { width: 16, height: 12, channels: 4 } }).png().toFile(atlasPath)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'inspect_sprite_sheet_layout', 'slice_sprite_sheet',
    ]))
    const inspection = await client.callTool({
      name: 'inspect_sprite_sheet_layout',
      arguments: { atlas_path: atlasPath },
    })
    const inspectionContent = inspection.content as Array<{ type: string; text?: string }>
    expect(inspectionContent.filter((item) => item.type === 'image')).toHaveLength(2)
    const text = inspectionContent.find((item) => item.type === 'text')
    expect(text?.type === 'text' && text.text ? JSON.parse(text.text).aiReviewTask.nextTool : null).toBe('slice_sprite_sheet')
    const outputDirectory = join(root, 'slices')
    const sliced = await client.callTool({
      name: 'slice_sprite_sheet',
      arguments: {
        atlas_path: atlasPath,
        output_directory: outputDirectory,
        mode: 'regions',
        bounds: 'polygon',
        regions: [{
          type: 'polygon',
          name: 'agent-confirmed',
          points: [{ x: 1, y: 1 }, { x: 12, y: 1 }, { x: 8, y: 10 }, { x: 1, y: 10 }],
        }],
      },
    })
    const slicedContent = sliced.content as Array<{ type: string; text?: string }>
    const resultText = slicedContent.find((item) => item.type === 'text')
    const result = resultText?.type === 'text' && resultText.text ? JSON.parse(resultText.text) : null
    expect(result?.mode).toBe('regions')
    expect((await sharp(result.files[0]).metadata()).format).toBe('png')
  })
})
