export type RgbColor = readonly [number, number, number]

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const srgbToLinear = (value: number) => {
  const channel = clamp01(value / 255)
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

const linearToSrgb = (value: number) => {
  const channel = clamp01(value)
  const encoded = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.round(clamp01(encoded) * 255)
}

export function parseHexColor(value: string): RgbColor {
  const normalized = value.trim().replace(/^#/, '')
  if (/^[a-f\d]{3}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized[0]! + normalized[0]!, 16),
      Number.parseInt(normalized[1]! + normalized[1]!, 16),
      Number.parseInt(normalized[2]! + normalized[2]!, 16),
    ]
  }
  if (/^[a-f\d]{6}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ]
  }
  return [0, 255, 0]
}

function isChromaDirected(color: readonly number[], key: readonly number[]) {
  const colorMean = (color[0]! + color[1]! + color[2]!) / 3
  const keyMean = (key[0]! + key[1]! + key[2]!) / 3
  const colorVector = [color[0]! - colorMean, color[1]! - colorMean, color[2]! - colorMean]
  const keyVector = [key[0]! - keyMean, key[1]! - keyMean, key[2]! - keyMean]
  const colorMagnitude = Math.hypot(...colorVector)
  const keyMagnitude = Math.hypot(...keyVector)
  if (colorMagnitude < 0.005 || keyMagnitude < 0.035) return false
  const cosine = colorVector.reduce((sum, channel, index) => sum + channel * keyVector[index]!, 0)
    / (colorMagnitude * keyMagnitude)
  return cosine >= 0.58
}

function makeBoundaryDistance(alpha: Uint8ClampedArray, width: number, height: number, maxDistance: number) {
  const length = width * height
  const distance = new Uint8Array(length)
  distance.fill(255)
  const queue = new Int32Array(length)
  let head = 0
  let tail = 0
  for (let index = 0; index < length; index += 1) {
    if ((alpha[index] ?? 0) > 0) continue
    distance[index] = 0
    queue[tail++] = index
  }
  while (head < tail) {
    const index = queue[head++]!
    const nextDistance = (distance[index] ?? 0) + 1
    if (nextDistance > maxDistance) continue
    const x = index % width
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      index >= width ? index - width : -1,
      index + width < length ? index + width : -1,
    ]
    for (const neighbor of neighbors) {
      if (neighbor < 0 || (distance[neighbor] ?? 0) <= nextDistance) continue
      distance[neighbor] = nextDistance
      queue[tail++] = neighbor
    }
  }
  return distance
}

function nearestCleanOwners(
  source: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  keyLinear: readonly number[],
) {
  const length = width * height
  const owners = new Int32Array(length)
  owners.fill(-1)
  const queue = new Int32Array(length)
  let head = 0
  let tail = 0
  for (let index = 0; index < length; index += 1) {
    if ((alpha[index] ?? 0) < 245) continue
    const offset = index * 4
    const color = [
      srgbToLinear(source[offset] ?? 0),
      srgbToLinear(source[offset + 1] ?? 0),
      srgbToLinear(source[offset + 2] ?? 0),
    ]
    if (isChromaDirected(color, keyLinear)) continue
    owners[index] = index
    queue[tail++] = index
  }

  while (head < tail) {
    const index = queue[head++]!
    const x = index % width
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < width ? index + 1 : -1,
      index >= width ? index - width : -1,
      index + width < length ? index + width : -1,
    ]
    for (const neighbor of neighbors) {
      if (neighbor < 0 || (owners[neighbor] ?? -1) >= 0 || (alpha[neighbor] ?? 0) === 0) continue
      owners[neighbor] = owners[index]!
      queue[tail++] = neighbor
    }
  }
  return owners
}

/**
 * Recover foreground RGB at a keyed silhouette boundary without changing the
 * alpha matte. Translucent pixels are unmixed with C = aF + (1-a)B; unstable
 * low-alpha estimates and opaque spill pixels borrow the nearest clean
 * interior colour in linear light. Fully transparent RGB is cleared.
 */
export function despillChromaPixels(
  source: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  keyColor: RgbColor,
): Uint8ClampedArray {
  const length = width * height
  if (source.length < length * 4 || alpha.length < length) {
    throw new Error('色度去溢出输入尺寸不一致')
  }
  const output = new Uint8ClampedArray(source)
  const bandWidth = Math.max(2, Math.min(6, Math.round(Math.min(width, height) / 256)))
  const boundaryDistance = makeBoundaryDistance(alpha, width, height, bandWidth)
  const keyLinear = keyColor.map(srgbToLinear)
  const owners = nearestCleanOwners(source, alpha, width, height, keyLinear)

  for (let index = 0; index < length; index += 1) {
    const offset = index * 4
    const opacityByte = alpha[index] ?? 0
    output[offset + 3] = opacityByte
    if (opacityByte === 0) {
      output[offset] = 0
      output[offset + 1] = 0
      output[offset + 2] = 0
      continue
    }

    const opacity = opacityByte / 255
    const inBoundaryBand = opacityByte < 250 || (boundaryDistance[index] ?? 255) <= bandWidth
    if (!inBoundaryBand) continue
    const sourceLinear = [
      srgbToLinear(source[offset] ?? 0),
      srgbToLinear(source[offset + 1] ?? 0),
      srgbToLinear(source[offset + 2] ?? 0),
    ]
    const owner = owners[index] ?? -1
    const ownerOffset = owner >= 0 ? owner * 4 : offset
    const interiorLinear = [
      srgbToLinear(source[ownerOffset] ?? source[offset] ?? 0),
      srgbToLinear(source[ownerOffset + 1] ?? source[offset + 1] ?? 0),
      srgbToLinear(source[ownerOffset + 2] ?? source[offset + 2] ?? 0),
    ]
    let corrected = sourceLinear

    if (opacityByte < 250 && owner >= 0) {
      corrected = interiorLinear
    } else if (opacityByte < 250) {
      const backgroundFraction = Math.min(0.945, 1 - opacity)
      const safeOpacity = Math.max(0.055, 1 - backgroundFraction)
      corrected = sourceLinear.map((channel, channelIndex) =>
        clamp01((channel - backgroundFraction * keyLinear[channelIndex]!) / safeOpacity))
    } else if (owner >= 0 && owner !== index && isChromaDirected(sourceLinear, keyLinear)) {
      corrected = interiorLinear
    }

    output[offset] = linearToSrgb(corrected[0]!)
    output[offset + 1] = linearToSrgb(corrected[1]!)
    output[offset + 2] = linearToSrgb(corrected[2]!)
  }
  return output
}

export function estimateSolidBackgroundColor(
  source: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
): RgbColor | null {
  const pixelCount = Math.min(alpha.length, Math.floor(source.length / 4))
  const stride = Math.max(1, Math.ceil(pixelCount / 8192))
  const samples: Array<[number, number, number]> = []
  for (let index = 0; index < pixelCount; index += stride) {
    if ((alpha[index] ?? 255) > 8) continue
    const offset = index * 4
    samples.push([source[offset] ?? 0, source[offset + 1] ?? 0, source[offset + 2] ?? 0])
  }
  if (samples.length < 24) return null
  const median = ([0, 1, 2] as const).map((channel) => {
    const values = samples.map((sample) => sample[channel]).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)] ?? 0
  }) as unknown as [number, number, number]
  const distances = samples.map((sample) => Math.hypot(
    sample[0] - median[0], sample[1] - median[1], sample[2] - median[2],
  )).sort((a, b) => a - b)
  const p90 = distances[Math.floor(distances.length * 0.9)] ?? Number.POSITIVE_INFINITY
  return p90 <= 28 ? median : null
}

export function refineAutomaticMatte(
  source: HTMLCanvasElement,
  matte: CanvasImageSource,
): HTMLCanvasElement {
  const width = source.width
  const height = source.height
  const sourceImage = source.getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, width, height)
  const matteCanvas = document.createElement('canvas')
  matteCanvas.width = width
  matteCanvas.height = height
  const matteContext = matteCanvas.getContext('2d', { willReadFrequently: true })!
  matteContext.drawImage(matte, 0, 0, width, height)
  const matteImage = matteContext.getImageData(0, 0, width, height)
  const alpha = new Uint8ClampedArray(width * height)
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = matteImage.data[index * 4 + 3] ?? 0
  const background = estimateSolidBackgroundColor(sourceImage.data, alpha)
  const outputPixels = background
    ? despillChromaPixels(sourceImage.data, alpha, width, height, background)
    : new Uint8ClampedArray(sourceImage.data)
  if (!background) {
    for (let index = 0; index < alpha.length; index += 1) outputPixels[index * 4 + 3] = alpha[index] ?? 0
  }
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const outputContext = output.getContext('2d')!
  sourceImage.data.set(outputPixels)
  outputContext.putImageData(sourceImage, 0, 0)
  return output
}
