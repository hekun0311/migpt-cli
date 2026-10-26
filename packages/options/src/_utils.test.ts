import { mergeWithUndefined } from './_utils.js'
import { test, expect, describe } from '@jest/globals'

describe('mergeWithUndefined', () => {
  test('删除关键词后替换数组，不保留旧的尾部项', () => {
    expect(
      mergeWithUndefined(
        { speaker: { switchSpeakerKeywords: ['把声音换成', '', '', ''] } },
        { speaker: { switchSpeakerKeywords: ['把声音换成'] } },
      ),
    ).toEqual({ speaker: { switchSpeakerKeywords: ['把声音换成'] } })
    expect(mergeWithUndefined({ keywords: ['旧值'] }, { keywords: [] })).toEqual({
      keywords: [],
    })
  })
  test('单层', () => {
    expect(mergeWithUndefined({ a: 1 }, { a: undefined })).toEqual({
      a: undefined,
    })
  })

  test('嵌套', () => {
    expect(
      mergeWithUndefined({ a: { b: 1 } }, { a: { b: undefined } }),
    ).toEqual({
      a: { b: undefined },
    })
  })

  test('多个对象', () => {
    expect(mergeWithUndefined({ a: 1 }, { a: undefined }, { a: 2 })).toEqual({
      a: 2,
    })
  })

  test('多个对象嵌套', () => {
    expect(
      mergeWithUndefined(
        { a: { b: 1 } },
        { a: { b: undefined } },
        { a: { b: 2 } },
      ),
    ).toEqual({
      a: { b: 2 },
    })
  })

  test('多个对象嵌套 2', () => {
    expect(
      mergeWithUndefined(
        { a: { b: 1 } },
        { a: { b: undefined } },
        { a: { b: 2 } },
        { a: { b: undefined } },
      ),
    ).toEqual({
      a: { b: undefined },
    })
  })

  test('对象为 undefined', () => {
    expect(mergeWithUndefined({ a: { b: 1 } }, { a: undefined })).toEqual({
      a: undefined,
    })
  })

  test('字段不存在', () => {
    expect(mergeWithUndefined({ a: { b: 1 } }, {})).toEqual({ a: { b: 1 } })
  })
})
