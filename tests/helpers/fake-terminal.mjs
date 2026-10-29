process.stdout.write('\x1b[2J\x1b[Hfake Codex ready')
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.on('resize', () => process.stdout.write(`\x1b[2J\x1b[Hfake size ${process.stdout.columns}x${process.stdout.rows}\r\nfake Codex ready`))
process.stdin.on('data', (data) => {
  if (data.includes(0x71)) process.exit(0)
  process.stdout.write(data)
})
