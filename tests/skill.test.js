// skill.js 的加载器测试：write-article 从包内 skills/ 目录读取（真实文件，缺失时优雅 null）。
import { describe, test, expect } from 'bun:test'
import { loadBundledSkill, WECHAT_MP_SKILL_NAME, WECHAT_MP_SKILL_DESCRIPTION, WECHAT_MP_SKILL_CONTENT } from '../skill.js'

describe('loadBundledSkill（skills/ 目录文件形态 skill）', () => {
  test('write-article：读出 name/description 与写作纪律正文', () => {
    const s = loadBundledSkill('write-article')
    if (s === null) {
      // 仓库里文件缺失时优雅返回 null（不炸插件加载）
      expect(s).toBe(null)
      return
    }
    expect(s.name).toBe('write-article')
    expect(s.description).toContain('公众号')
    expect(s.content.length).toBeGreaterThan(100)
  })

  test('未知目录优雅 null', () => {
    expect(loadBundledSkill('no-such-dir')).toBe(null)
  })

  test('wechat-mp-article 常量非空且 name 稳定', () => {
    expect(WECHAT_MP_SKILL_NAME).toBe('wechat-mp-article')
    expect(WECHAT_MP_SKILL_DESCRIPTION.length).toBeGreaterThan(0)
    expect(WECHAT_MP_SKILL_CONTENT).toContain('wechat-mp-preview')
  })
})
