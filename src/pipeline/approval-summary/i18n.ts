/**
 * 审批摘要的中文文案常量。
 * 集中放在此处便于后续 i18n 改造（仅替换此文件即可切语言）。
 */
export const SpecSummaryI18n = {
  TITLE: 'Spec 评审',
  HINT_QUICK_PASS: '看起来可快速批',
  HINT_HIGH_RISK: '建议关注下方 high 风险',
  HINT_ESCALATION: '建议 escalation',
  SECTION_EVAL: '本次评估',
  SECTION_REVIEW_HINTS: '需要你 review 的点',
  SECTION_ASSUMPTIONS: 'LLM 替你做的决定',
  SECTION_SCOPE: '范围',
  SECTION_ROUND_DIFF: '上轮反馈 ↔ 本轮变化',
  EMPTY_HINTS: '✅ LLM 无主动提示，请抽查',
  TWO_COLUMN_NOTE: '两栏不强对应仅供参考',
  DETAILS_AC: '验收标准',
  DETAILS_REFS: '涉及代码',
  DETAILS_CLARIFS: '完整澄清问题',
  DETAILS_FULL_SPEC: '完整 spec.md（9 章节）',
  REJECT_REASONS_HEADER: '上轮拒绝原因',
  REVIEWER_NOTES_HEADER: 'Reviewer 标记',
  AC_DIFF_ADDED: '新增 AC',
  AC_DIFF_REMOVED: '删除 AC',
  AC_DIFF_CHANGED: '修订 AC',
  CONFIDENCE_PREFIX: '置信',
  IM_LINK_LABEL: '审批',
}

/** 严重度排序（数字越小越前置）*/
export function severityOrder(s: string): number {
  return s === 'high' ? 0 : s === 'medium' ? 1 : 2
}
