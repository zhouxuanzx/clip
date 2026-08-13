/**
 * Win32 API 薄封装，用 koffi 免编译调用系统 DLL。
 * 非 Windows 平台上全部降级为空实现，方便在别的系统上跑起来调 UI。
 */

interface Win32Bindings {
  getClipboardSequenceNumber(): number
  getForegroundWindow(): number
  getWindowTitle(hwnd: number): string
  focusWindow(hwnd: number): boolean
}

const NOOP: Win32Bindings = {
  getClipboardSequenceNumber: () => 0,
  getForegroundWindow: () => 0,
  getWindowTitle: () => '',
  focusWindow: () => false
}

function loadWin32(): Win32Bindings {
  if (process.platform !== 'win32') return NOOP

  try {
    // koffi 只在 Windows 分支加载，别的平台连 require 都不做
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')

    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    const GetClipboardSequenceNumber = user32.func('uint32 GetClipboardSequenceNumber()')
    const GetForegroundWindow = user32.func('void* GetForegroundWindow()')
    const SetForegroundWindow = user32.func('bool SetForegroundWindow(void* hWnd)')
    const GetWindowTextW = user32.func('int GetWindowTextW(void* hWnd, _Out_ uint16_t* buf, int max)')
    const GetWindowThreadProcessId = user32.func(
      'uint32 GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId)'
    )
    const AttachThreadInput = user32.func(
      'bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'
    )
    const IsIconic = user32.func('bool IsIconic(void* hWnd)')
    const ShowWindow = user32.func('bool ShowWindow(void* hWnd, int nCmdShow)')
    const BringWindowToTop = user32.func('bool BringWindowToTop(void* hWnd)')
    const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()')

    const SW_RESTORE = 9

    /** koffi 的 void* 在 JS 侧是 external 对象，这里用数字句柄来回转换 */
    const handles = new Map<number, unknown>()
    let nextKey = 1

    const toKey = (hwnd: unknown): number => {
      if (!hwnd) return 0
      const key = nextKey++
      handles.set(key, hwnd)
      // 只保留最近若干个句柄，防止长期运行内存增长
      if (handles.size > 32) handles.delete(handles.keys().next().value as number)
      return key
    }

    return {
      getClipboardSequenceNumber: () => GetClipboardSequenceNumber(),

      getForegroundWindow: () => toKey(GetForegroundWindow()),

      getWindowTitle: (key) => {
        const hwnd = handles.get(key)
        if (!hwnd) return ''
        const buf = new Uint16Array(512)
        const len = GetWindowTextW(hwnd, buf, buf.length)
        if (len <= 0) return ''
        return Buffer.from(buf.buffer, 0, len * 2).toString('utf16le')
      },

      focusWindow: (key) => {
        const hwnd = handles.get(key)
        if (!hwnd) return false

        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)

        // Windows 有"前台窗口锁"：非前台进程直接 SetForegroundWindow 会被忽略。
        // 把自己的线程输入队列附到目标窗口的线程上，就能绕过这个限制。
        const targetThread = GetWindowThreadProcessId(hwnd, null)
        const ownThread = GetCurrentThreadId()
        const attached =
          targetThread !== 0 && targetThread !== ownThread
            ? AttachThreadInput(ownThread, targetThread, true)
            : false
        try {
          BringWindowToTop(hwnd)
          return SetForegroundWindow(hwnd)
        } finally {
          if (attached) AttachThreadInput(ownThread, targetThread, false)
        }
      }
    }
  } catch (err) {
    console.error('[win32] koffi 加载失败，相关功能降级：', err)
    return NOOP
  }
}

export const win32: Win32Bindings = loadWin32()

export const isWindows = process.platform === 'win32'
