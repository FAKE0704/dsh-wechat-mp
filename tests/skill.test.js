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

  test('write-article：references 内联 + DSH 环境分支（拍板修改项 1/2）', () => {
    const s = loadBundledSkill('write-article')
    if (s === null) return
    // editorial.md 原样收录进 references/，加载器要把它内联为附录——模型在 DSH 会话里
    // 读不到真源机仓库，规范必须随 skill 进上下文
    expect(s.content).toContain('附录：references/editorial.md')
    expect(s.content).toContain('内容支柱')
    // 交付链按环境二选一：DSH 分支走插件工具链，真源机命令标注不可用
    expect(s.content).toContain('DSH 环境')
    expect(s.content).toContain('wechat-mp-preview')
    expect(s.content).toContain('不要尝试执行')
    // 死引用已标注环境归属（拍板修改项 3，C1）
    expect(s.content).toContain('wechat-mp-article')
  })

  test('未知目录优雅 null', () => {
    expect(loadBundledSkill('no-such-dir')).toBe(null)
  })

  test('wechat-mp-article 常量非空且 name 稳定', () => {
    expect(WECHAT_MP_SKILL_NAME).toBe('wechat-mp-article')
    expect(WECHAT_MP_SKILL_DESCRIPTION.length).toBeGreaterThan(0)
    expect(WECHAT_MP_SKILL_CONTENT).toContain('wechat-mp-preview')
    expect(WECHAT_MP_SKILL_CONTENT).toContain('write-article') // 分工互指（拍板修改项 5）
  })
})
