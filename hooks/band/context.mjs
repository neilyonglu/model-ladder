// 35000 -> 35k, 1000000 -> 1M, 1500000 -> 1.5M, 200000 -> 200k.
const abbreviate = (n) => {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

// Share of the window in use, rounded to one decimal with no trailing ".0": 28.7 -> "28.7", 50 -> "50".
const percentOf = (tokens, window) => `${Number(((tokens / window) * 100).toFixed(1))}`

// Context window usage for the band: "ctx 287k/1M (28.7%)" when tokens and window are known; "ctx 1M" when only the window is known; empty when the window is unknown too.
export const formatContext = (context) => {
  const window = context?.window
  const hasWindow = Number.isFinite(window) && window > 0
  const hasTokens = Number.isFinite(context?.tokens) && context.tokens >= 0
  if (hasTokens && hasWindow) {
    return `ctx ${abbreviate(context.tokens)}/${abbreviate(window)} (${percentOf(context.tokens, window)}%)`
  }
  if (hasWindow) return `ctx ${abbreviate(window)}`
  return ''
}
