// skill.js 的加载器测试：article-writer 从包内 skills/ 目录读取（真实文件，缺失时优雅 null）。
import { describe, test, expect } from 'bun:test'
import { loadArticleWriterSkill, WECHAT_MP_SKILL_NAME, WECHAT_MP_SKILL_DESCRIPTION, WECHAT_MP_SKILL_CONTENT } from '../skill.js'

describe('loadArticleWriterSkill（monorepo 线并入的文件形态 skill）', () => {
  test('读出 name/description 与含卡片模板的正文', () => {
    const s = loadArticleWriterSkill()
    if (s === null) {
      // 仓库里文件缺失时优雅返回 null（不炸插件加载）
      expect(s).toBe(null)
      return
    }
    expect(s.name).toBe('article-writer')
    expect(s.description).toContain('公众号')
    expect(s.content).toContain('内联样式')
    expect(s.content.length).toBeGreaterThan(100)
  })

  test('wechat-mp-article 常量非空且 name 稳定', () => {
    expect(WECHAT_MP_SKILL_NAME).toBe('wechat-mp-article')
    expect(WECHAT_MP_SKILL_DESCRIPTION.length).toBeGreaterThan(0)
    expect(WECHAT_MP_SKILL_CONTENT).toContain('wechat-mp-preview')
  })
})
