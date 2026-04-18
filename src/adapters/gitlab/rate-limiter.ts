const DEFAULT_RATE = 10
const DEFAULT_BURST = 20
const MAX_BUCKETS = 100

interface TokenBucket {
  tokens: number
  lastRefill: number
  rate: number
  burst: number
}

const buckets = new Map<string, TokenBucket>()

function evictOldBuckets(): void {
  if (buckets.size <= MAX_BUCKETS) return
  // 删除最久未使用的
  const oldest = [...buckets.entries()].sort((a, b) => a[1].lastRefill - b[1].lastRefill)
  while (buckets.size > MAX_BUCKETS) {
    const entry = oldest.shift()
    if (entry) buckets.delete(entry[0])
  }
}

function getBucket(key: string): TokenBucket {
  if (!buckets.has(key)) {
    evictOldBuckets()
    buckets.set(key, { tokens: DEFAULT_BURST, lastRefill: Date.now(), rate: DEFAULT_RATE, burst: DEFAULT_BURST })
  }
  const bucket = buckets.get(key)!
  const now = Date.now()
  const elapsed = (now - bucket.lastRefill) / 1000
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + elapsed * bucket.rate)
  bucket.lastRefill = now
  return bucket
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withRateLimit<T>(
  key: string,
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  const bucket = getBucket(key)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (bucket.tokens < 1) {
      const waitMs = ((1 - bucket.tokens) / bucket.rate) * 1000
      console.log(`[GitLab] rate limit: waiting ${waitMs.toFixed(0)}ms (attempt ${attempt + 1})`)
      await sleep(waitMs)
      getBucket(key)
    }

    bucket.tokens -= 1

    try {
      return await fn()
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429 && attempt < maxRetries) {
        const baseMs = Math.pow(2, attempt) * 1000
        const jitter = Math.random() * baseMs * 0.5
        const backoffMs = baseMs + jitter
        console.warn(`[GitLab] 429 rate limited, backing off ${backoffMs.toFixed(0)}ms (attempt ${attempt + 1}/${maxRetries})`)
        await sleep(backoffMs)
        continue
      }
      throw err
    }
  }

  throw new Error(`[GitLab] max retries (${maxRetries}) exceeded`)
}
