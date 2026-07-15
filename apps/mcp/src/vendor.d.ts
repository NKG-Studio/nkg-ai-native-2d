declare module 'ffprobe-static' {
  const ffprobe: {
    path: string
    version?: string
  }
  export default ffprobe
}
