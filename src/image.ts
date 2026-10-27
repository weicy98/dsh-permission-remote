/** Magic-byte media type for the image formats read_image accepts. */
export function sniffImage(data: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  const gif = data.length >= 6 ? data.toString('ascii', 0, 6) : ''
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  return undefined
}
