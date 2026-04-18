const PATTERNS: { regex: RegExp; replacement: string }[] = [
  // 密码字段
  { regex: /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?([^'"\s,;\n}]{3,})['"]?/gi, replacement: '$1=[MASKED]' },
  // 数据库连接串
  { regex: /(postgres|mysql|mongodb|jdbc)(:\/\/)[^\s'"]+/gi, replacement: '$1$2[MASKED_DB_URL]' },
  // AWS Access Key
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: '[MASKED_AWS_KEY]' },
  // IP 地址
  { regex: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g, replacement: '[MASKED_IP]' },
  // JWT Token
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[MASKED_JWT]' },
  // Bearer Token
  { regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/gi, replacement: 'Bearer [MASKED_TOKEN]' },
  // 私钥
  { regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, replacement: '[MASKED_PRIVATE_KEY]' },
  // 邮箱（完全脱敏）
  { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[MASKED_EMAIL]' },
  // 手机号
  { regex: /\b1[3-9]\d{9}\b/g, replacement: '[MASKED_PHONE]' },
]

// 内网 IP 白名单（不脱敏 localhost 和常见内网段的描述性引用）
const IP_WHITELIST = ['127.0.0.1', '0.0.0.0', 'localhost']

export function mask(text: string): string {
  let result = text
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, (match, ...args) => {
      // IP 白名单检查
      if (regex.source.includes('\\d{1,3}')) {
        if (IP_WHITELIST.includes(match)) return match
      }
      return replacement.replace(/\$(\d)/g, (_, i) => args[parseInt(i) - 1] ?? '')
    })
  }
  return result
}
