import { win32, isWindows } from './win32'

/**
 * 把内容粘贴回"唤起小窗之前的那个窗口"。
 *
 * 顺序很关键：小窗是用 showInactive() 显示的，不抢焦点，
 * 但用户点击列表时焦点仍会转移到小窗。所以粘贴前要主动把焦点还给目标窗口，
 * 等系统真正完成焦点切换后，才发 Ctrl+V。
 */
export async function pasteToPreviousWindow(targetHwnd: number): Promise<boolean> {
  if (!isWindows || !targetHwnd) return false

  const focused = win32.focusWindow(targetHwnd)
  if (!focused) return false

  // 焦点切换是异步的，立刻发按键会打到旧窗口上
  await delay(120)

  try {
    // robotjs 只在真正要用时加载：它是原生模块，
    // 在没有预编译二进制的平台上 require 就会抛错
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const robot = require('robotjs') as typeof import('robotjs')
    robot.keyTap('v', ['control'])
    return true
  } catch (err) {
    console.error('[paste] 模拟按键失败：', err)
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
