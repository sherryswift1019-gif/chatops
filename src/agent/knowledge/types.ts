export interface KnowledgeEntry {
  id: string
  type: 'knowledge' | 'guide'
  keywords: string[]
  errorCodes: string[]
  modules: string[]
  product: string
  versions: string
  file: string
  hitCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface IndexFile {
  entries: KnowledgeEntry[]
}

export interface SearchResult {
  entry: KnowledgeEntry
  score: number
  content: string
}
